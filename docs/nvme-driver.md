# How does the Linux kernel-level NVMe driver work?

NOTE: Linux NVMe driver is a kernel module, thus it runs in the kernel space with the kernel priveleges.

The NVMe module is initialized as a typical Linux module, in /drivers/nvme/host/pci.c:
```c
module_init(nvme_init);
module_exit(nvme_exit);
```

`nvme_init` registers the nvme driver in the pci via `pci_register_driver`:

```c
static int __init nvme_init(void)
{
	BUILD_BUG_ON(sizeof(struct nvme_create_cq) != 64);
	BUILD_BUG_ON(sizeof(struct nvme_create_sq) != 64);
	BUILD_BUG_ON(sizeof(struct nvme_delete_queue) != 64);
	BUILD_BUG_ON(IRQ_AFFINITY_MAX_SETS < 2);

	return pci_register_driver(&nvme_driver);
}
```

If we inspect `pci_register_driver`, we can see that it basically registers a new pci driver in the system:

```c
/**
 * __pci_register_driver - register a new pci driver
 * @drv: the driver structure to register
 * @owner: owner module of drv
 * @mod_name: module name string
 *
 * Adds the driver structure to the list of registered drivers.
 * Returns a negative value on error, otherwise 0.
 * If no error occurred, the driver remains registered even if
 * no device was claimed during registration.
 */
int __pci_register_driver(struct pci_driver *drv, struct module *owner,
			  const char *mod_name)
{
	/* initialize common driver fields */
	drv->driver.name = drv->name;
	drv->driver.bus = &pci_bus_type;
	drv->driver.owner = owner;
	drv->driver.mod_name = mod_name;
	drv->driver.groups = drv->groups;
	drv->driver.dev_groups = drv->dev_groups;

	spin_lock_init(&drv->dynids.lock);
	INIT_LIST_HEAD(&drv->dynids.list);

	/* register with core */
	return driver_register(&drv->driver);
}
```

Anyways, back to the NVMe driver. The driver is represented as a `pci_driver` struct, which is
defined as:

```c
static struct pci_driver nvme_driver = {
	.name		= "nvme",
	.id_table	= nvme_id_table,
	.probe		= nvme_probe,
	.remove		= nvme_remove,
	.shutdown	= nvme_shutdown,
	.driver		= {
		.probe_type	= PROBE_PREFER_ASYNCHRONOUS,
#ifdef CONFIG_PM_SLEEP
		.pm		= &nvme_dev_pm_ops,
#endif
	},
	.sriov_configure = pci_sriov_configure_simple,
	.err_handler	= &nvme_err_handler,
};
```

- `nvme_id_table` table is just a big table of information on NVMe manufacturers, ranging from Intel to Qemu's emulated hardware.
- `nvme_probe` is a probing function that gets called during execution of `pci_register_device()` for the drive to take ownership of a device in the device id table.
- `nvme_remove` function gets called whenever a device being handled by the driver is removed.
- `nvme_shutdown` function has the intention of stopping any idling DMA operations.
- `driver` anonymous struct is a `device_driver` struct, which contains information about the "basic device driver" (Linux docs). It contains information about the name, bus, owner, module name, etc. of the driver. This is defined in `/include/linux/device/driver.h` if you want to check it out for more information.

#### How is the NVMe driver initialized?

The PCI core compares discovered PCI devices against the driver's `id_table`. If a device matches and is not already owned by another driver, the PCI core calls the driver's probing function.

Therefore, in `nvme_probe()` function, the driver has to claim the ownership of the passed in `pci_dev` device. The driver does this by:

1. `struct nvme_dev* dev = nvme_pci_alloc_dev(pdev, id);`: This allocates a driver-private state.

The device allocation initializes the NVMe controller via: `nvme_init_ctrl(&dev->ctrl, &pdev->dev, ...)`. This function sets the controller's `dev` device (which is the parent PCI device) to be the PCI device's `device` struct (we will come back to this later).

An `nvme_dev` struct represents an NVMe device. "Each `nvme_dev` is a PCI function" (Linux). The struct has data on:
- nvme queues
- tagset
- I/O queue list
- mapped BAR size
- `struct nvme_ctrl ctrl`: the controller itself
and other NVMe related fields. One of the important fields is the controller, which is an `nvme_ctrl` struct. 

> NOTE: The NVMe controller is treated as a character device, whereas the NVMe itself is treated as a block device.

A careful eye may notice that this struct contains 3 separate device fields:
```c
struct device* dev;
struct device ctrl_device;
struct device* device;
```

- The first device is the parent/transport device. For PCI NVMe, this is the PCI device itself and is set to the PCI device as the first step of probing. This device may be, for example: `/sys/bus/pci/devices/0000:01:00.0`, which is a PCI function.

- The second one is the embedded NVMe controller device object itself (e.g. `nvme0`). This is initialized in `nvme_init_ctrl()` function as:
```c
device_initialize(&ctrl->ctrl_device);
```

- The third is a pointer to ctrl_device which is used as a character device. This is again initialized in the same function as:
```c
ctrl->device = &ctrl->ctrl_device;
```

> IMPORTANT: The controller device is then set to be the child of the PCIe device in the same function again as `ctrl->device->parent = ctrl->dev;`


2. `int result = nvme_add_ctrl(&dev->ctrl);`: This registers the NVMe controller object.

This NVMe controller contains all the admin queues, namespace information, the nvme subsytem, and a dozen of other stuff.

The `nvme_add_ctrl()` function returns an "elevated controller reference". Some important bits I found that are helpful are:
- `dev_set_name(ctrl->device, "nvme%d", ctrl->instancer)`: sets the nvme device name


```c
cdev_init(&ctrl->cdev, &nvme_dev_fops);
ctrl->cdev.owner = ctrl->ops->module;
ret = cdev_device_add(&ctrl->cdev, ctrl->device);
```

This sequence initializes a **character** device, sets the owner to be the nvme kernel module, and adds the character device to the system.

3. `nvme_dev_map(dev);`: This remaps the BAR region of the device, with the size of `NVME_REG_DBS + 4096`. 
- NOTE: `NVME_REG_DBS` is the Submission Queue 0 Tail Doorbell register address, which is set as `0x1000`.

[I am omitting some code in between for the sake of brevity...]

4. `nvme_pci_enable(dev)`: This function turns the PCI NVMe controller into a usable state and sets up the admin queue, which is the first queue needed before the driver can send NVMe admin commands. Specifically, this function does:
- Enables PCI devices
- Enables DMA
- Checks whether the controller is readable
- Allocates initial interrupt vector
- Reads NVMe capabilities
- Computes queue and doorbell parameters
- Configures the admin queue

Here is the summary of the important lines I found, line by line:

- `pci_enable_device_mem(to_pci_dev(dev->dev))`: "Initializes a device before it is used by a driver". This asks the PCI core to enable the device for MMIO use. 

> NOTE: NVMe controllers expose their registers through the PCI's BAR memory. Therefore,  it is important to initialize a device with the corrrect memory resources to be able to access the BAR via memory-mapped registers.

- `pci_set_master(pdev)`: "Enables bus-masering on the device and calls pcibios_master() to do the needed arch specific settings"

> NOTE: NVMe uses DMA a lot for submission queues, completion queues, PRP lists, etc. This function enables the PCI device to become a bus master, therefore the device can now initiate DMA reads and writes to system memory. 

**Which bus is being "mastered" though?** 
In traditional and legacy systems where the computer architecture contains the Northbridge/Southbridge, when a device becomes bus master, it is taking control of its local bus (which is the link that connects it to the Southbridge). 

Note that the device **DOES NOT** master the memory bus directly as it has no wires touching the memory controller. Even though devices like NVMes and GPUs are designed to be high-speed, they never become masters of the actual memory bus. The memory bus (DDR4/DDR5) is an ultra-fast connection that belongs exlucisevly to CPU's integrated memory controller. 

Especially in modern mobile/laptop systems the PCH functionality is embedded entirely into the CPU package as a SoC. Therefore, the tansition to the PCIe architecture made every device a bus master by default regardless of whether a physical PCH exists (due to the point-to-point network architecture of PCIe), so every PCIe device can initiate DMA requests through their own DMA engines, and send these DMA requests over the PCIe wires as standard packets.


A distinction between high-speed and standard devices is:
- Modern CPUs have PCIe controllers baked onto the main processor die. When high speed devices (GPU/NVMe) initiate a DMA transfer, the device takes control of the bus and sends a memory request directly to the CPU chip, which is handled by an internal bus and passed to the IOMMU for memory validation and address translation. Then the internal memory controller accepts the request and executes the read/write on the DDR memory bus.
- Standard devices (Audio, LAN, SATA) master the PCIe bus connected to the PCH which forwards it across the Direct Media Interface (DMI) link (bus between the chipset and the CPU), which is then executed as the same as the high-speed devices inside the CPU.

Therefore, the main distinction is that high-speed devices sends its request directly to the CPU, whereas standard devices send their requests to PCH first which is then forwarded to the CPU via DMI/OPI. Therefore, high-speed devices directly avoid the contention in the DMI link. Note that in the SoC designs, the bus between the embedded PCH and CPU cores is an internal, ultra-fast silicon interconnect rather than the external DMI bus.

Anyways:

- `readl(dev->bar + NVME_REG_CSTS) == -1`: Checks that the controller responds. `CSTS` is the NVMe controller status register, and the driver reads it via the mapped BAR.

- `dev->ctrl.cap = lo_hi_readq(dev->bar + NVME_REG_CAP);`: Reads the capabilities register

- NVMe Field Calculations:
```c
dev->q_depth = min_t(u32, NVME_CAP_MQES(dev->ctrl.cap) + 1, io_queue_depth);
dev->db_stride = 1 << NVME_CAP_STRIDE(dev->ctrl.cap);
dev->dbs = dev->bar + 4096;
```
These calculate the queue depth, the doorbell stride and the doorbell base.

- `nvme_map_cmb(dev)`: Maps the controller memory buffer
- `pci_save_state(pdev)`: Saves PCI configuration state so it can be restored after rest/suspend/error recovery.
- `nvme_pci_configure_admin_queue(dev)`: Creates and enables NVMe queue pair 0, the admin submission queue and the admin completion queue.

##### Admin Queue Configuration

TODO:
