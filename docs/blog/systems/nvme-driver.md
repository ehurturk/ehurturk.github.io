---
icon: lucide/hard-drive
---

# How Does the Linux Kernel-Level NVMe Driver Work?

!!! note

    The Linux NVMe driver is a kernel module, so it runs in kernel space with kernel privileges.

## Module and PCI registration

The NVMe module is initialized like a typical Linux module, in `drivers/nvme/host/pci.c`:

```c
module_init(nvme_init);
module_exit(nvme_exit);
```

`nvme_init` registers the NVMe driver with the PCI subsystem via `pci_register_driver`:

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

Looking inside `pci_register_driver`, it basically adds the driver to the list of registered PCI drivers:

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

The driver itself is represented as a `pci_driver` struct:

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

- `nvme_id_table` is a table of NVMe manufacturer/device IDs, from Intel to QEMU's emulated hardware.
- `nvme_probe` is the probe function, called during `pci_register_device()` when the driver takes ownership of a device that matches the ID table.
- `nvme_remove` is called when a device owned by the driver is removed.
- `nvme_shutdown` stops any in-flight DMA operations before shutdown.
- `driver` is a `device_driver` struct — the "basic device driver" fields (name, bus, owner, module name, etc.), defined in `include/linux/device/driver.h`.

## How is the NVMe driver initialized?

The PCI core compares discovered PCI devices against the driver's `id_table`. If a device matches and isn't already owned by another driver, the PCI core calls the driver's probe function.

So in `nvme_probe()`, the driver has to claim ownership of the passed-in `pci_dev`. It does this in a few steps:

**1. Allocate driver-private state** — `struct nvme_dev* dev = nvme_pci_alloc_dev(pdev, id);`

This also initializes the NVMe controller via `nvme_init_ctrl(&dev->ctrl, &pdev->dev, ...)`, which sets the controller's `dev` field to the parent PCI device's `device` struct.

An `nvme_dev` struct represents an NVMe device — "each `nvme_dev` is a PCI function" (per the kernel docs). It holds the NVMe queues, tagset, I/O queue list, mapped BAR size, the controller itself (`struct nvme_ctrl ctrl`), and other NVMe-related fields.

!!! note

    The NVMe controller is treated as a character device, while the NVMe device itself is treated as a block device.

`nvme_dev` actually contains three separate device fields:

```c
struct device* dev;
struct device ctrl_device;
struct device* device;
```

- `dev` is the parent/transport device. For PCI NVMe, this is the PCI device itself, e.g. `/sys/bus/pci/devices/0000:01:00.0`.
- `ctrl_device` is the embedded NVMe controller device object (e.g. `nvme0`), initialized in `nvme_init_ctrl()` via `device_initialize(&ctrl->ctrl_device)`.
- `device` is a pointer to `ctrl_device`, used as the character device: `ctrl->device = &ctrl->ctrl_device;`.

    !!! important

        The controller device is then set as a child of the PCIe device, in the same function: `ctrl->device->parent = ctrl->dev;`

**2. Register the NVMe controller** — `int result = nvme_add_ctrl(&dev->ctrl);`

The controller holds all the admin queues, namespace information, the NVMe subsystem, and more. `nvme_add_ctrl()` returns an elevated controller reference. A few notable bits along the way:

- `dev_set_name(ctrl->device, "nvme%d", ctrl->instance)` sets the NVMe device's name.
- The controller's character device is initialized and added to the system:

  ```c
  cdev_init(&ctrl->cdev, &nvme_dev_fops);
  ctrl->cdev.owner = ctrl->ops->module;
  ret = cdev_device_add(&ctrl->cdev, ctrl->device);
  ```

**3. Remap the BAR region** — `nvme_dev_map(dev);` remaps the device's BAR region, sized `NVME_REG_DBS + 4096`.

  !!! note

      `NVME_REG_DBS` is the address of the Submission Queue 0 Tail Doorbell register, `0x1000`.

*(Omitting some code in between for brevity.)*

**4. Bring the PCI NVMe controller up** — `nvme_pci_enable(dev)` gets the controller into a usable state and sets up the admin queue, the first queue needed before the driver can send NVMe admin commands. Specifically, it:

- Enables the PCI device
- Enables DMA
- Checks that the controller is readable
- Allocates the initial interrupt vector
- Reads the NVMe capabilities
- Computes queue and doorbell parameters
- Configures the admin queue

The important calls along the way, roughly in order:

- `pci_enable_device_mem(to_pci_dev(dev->dev))` — initializes the device before a driver uses it, asking the PCI core to enable it for MMIO. NVMe controllers expose their registers through PCI BAR memory, so the device needs the right memory resources mapped before the BAR's memory-mapped registers can be accessed.

- `pci_set_master(pdev)` — enables bus-mastering on the device and calls `pcibios_set_master()` to apply arch-specific settings. NVMe relies heavily on DMA for submission queues, completion queues, and PRP lists, so this lets the PCI device initiate DMA reads and writes to system memory on its own.

    **Which bus is actually being "mastered"?** On legacy systems with a Northbridge/Southbridge, becoming bus master means taking control of the device's local bus — the link to the Southbridge. The device never masters the memory bus directly; it has no wires to the memory controller. Even fast devices like NVMes and GPUs never become masters of the actual DDR memory bus, which belongs exclusively to the CPU's integrated memory controller.

    On modern mobile/laptop systems, the PCH is embedded into the CPU package as an SoC. The move to PCIe's point-to-point topology made every device a bus master by default, PCH or not — every PCIe device has its own DMA engine and sends DMA requests as standard packets over the PCIe wires.

    There's still a distinction between high-speed and standard devices:

    - Modern CPUs have PCIe controllers on-die. When a high-speed device (GPU/NVMe) initiates a DMA transfer, it sends a memory request directly to the CPU, which routes it through an internal bus to the IOMMU for validation and address translation, then to the memory controller for the DDR read/write.
    - Standard devices (audio, LAN, SATA) go through the PCH first, which forwards the request across the DMI link to the CPU, where it's handled the same way as high-speed devices from that point on.

    So the key difference is that high-speed devices talk to the CPU directly, while standard devices are relayed through the PCH via DMI/OPI — meaning high-speed devices avoid DMI-link contention entirely. (In SoC designs, the "link" between the embedded PCH and CPU cores is an internal, ultra-fast silicon interconnect rather than an external DMI bus.)

- `readl(dev->bar + NVME_REG_CSTS) == -1` — checks that the controller responds. `CSTS` is the NVMe controller status register, read through the mapped BAR.

- `dev->ctrl.cap = lo_hi_readq(dev->bar + NVME_REG_CAP);` — reads the capabilities register.

- NVMe field calculations:

  ```c
  dev->q_depth = min_t(u32, NVME_CAP_MQES(dev->ctrl.cap) + 1, io_queue_depth);
  dev->db_stride = 1 << NVME_CAP_STRIDE(dev->ctrl.cap);
  dev->dbs = dev->bar + 4096;
  ```

  These compute the queue depth, the doorbell stride, and the doorbell base.

- `nvme_map_cmb(dev)` — maps the controller memory buffer.
- `pci_save_state(pdev)` — saves PCI configuration state so it can be restored after reset, suspend, or error recovery.
- `nvme_pci_configure_admin_queue(dev)` — creates and enables NVMe queue pair 0, the admin submission and completion queues.

### Admin queue configuration

!!! note "Work in progress"

    I haven't written up admin queue configuration yet — I'll add it here once it's done.
