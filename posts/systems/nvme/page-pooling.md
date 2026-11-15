---
icon: lucide/memory-stick
---

# NVMe #1: Implementing Page Pool for NVMe Driver

This is a relatively simple post, which talks about implementing a simple page pool for DMA buffers in the NVMe setup.

## Introduction

This is intended to be part 1 of my series in NVMe driver development. I have already a working base and have just started considering writing the process, so we are starting from the middle of the book.

The current API for initializing the controller looks like:

```c++
// Initialize the DMA heap: a very barebones DMA memory allocator
dma::DmaHeap dma_heap{container};

// Initialize the controller
nvme::Controller controller{nvme::NvmeDeviceHandle(/* bar0 region */, dma_heap)};

// Configure the controller
auto configured = controller.configure();
```

For example, we can send I/O commands to the controller via:

```c++
// Send a simple write command to the controller:

// allocate 4 pages
dma::DmaBuffer write_buf = dma_heap.alloc(512 * 4, controller_config.nvme_page_size);

// populate the write buffer
constexpr std::string_view msg = "hello nvme";
std::span<const std::byte> buf = std::as_bytes(std::span{str});

// prepare the DMA'able memory address with the message
std::memcpy(write_buf.uva(), buf.data(), buf.size());

// execute a Write command to NSID 1, starting at LBA 0x0
auto written = controller.execute(io_qid, nvme::io::commands::Write{1, 0x0, 3}, std::move(write_buf));

// ...
```

The API is simple enough, though we have to make sure we allocate the DMA buffer and pass it to the `execute` function.

## The Problem

The `DmaHeap` class allocates `DmaBuffer`s rather naively as I didn't implement any allocator for it yet. On `allocate`, it really just creates a new `DmaBuffer`:

```c++
DmaBuffer DmaHeap::alloc(std::size_t bytes, std::size_t alignment) {
    return DmaBuffer{*container_, bytes, alignment};
}
```

The constructor of the `DmaBuffer` takes care of `mmap`ing the user memory with `MAP_ANONYMOUS` and then registers an IOMMU mapping through VFIO.
For a single DmaBuffer allocation, this is actually a lot of steps:

1. Allocating memory (even though it will be demand paged it still is a system call)
2. Registering an IOMMU DMA mapping (which will walk through the user pages and pin them to make them contiguous)

There is also the tear down aspect as well, which sets the system call debt per command to 4.

In addition, unmapping a buffer while the device may still using it is unsafe and could easily be done as the lifetime is tied to resource allocation.

In terms of RAII, this is actually a good idea but we would like to avoid the cost of these altogether while still having clear lifetime guarantees. Therefore, we can have a page pool that maps the pages and the IOMMU DMA mappings once at startup and hands out page indices from the pool as needed. Allocating and releasing then costs no system calls, and pages stay mapped for the pool's lifetime.

## Implementation

We can have these simple class for a page allocator:
```c++
// a page pool that preallocates a list of pages at construction time
class PagePool {
public:
    PagePool(vfio::VfioContainer& container, std::size_t page_size, std::uint32_t page_count);
    ~PagePool() = default;

    // delete copy and move constructors...

    std::optional<PageAllocation> allocate();

private:
    void release(const PageAllocation& buffer);

    DmaBuffer region_;
    std::uint32_t page_count_;
    std::size_t page_size_;

    std::vector<std::uint32_t> free_list_;

    friend struct PageAllocation;
};
```

The `allocate()` function will simply try to return a page from the index of an element in the free list, and `release()` will push back to the free list. The returned page allocation structure looks something like:

```c++
struct PageAllocation {
private:
    using IOVA = std::uint64_t;
public:
    PageAllocation(PagePool* pool, DmaView view, std::uint32_t idx);
    ~PageAllocation() = default;

    // move and copy constructors omitted...

    std::byte* uva() const;
    IOVA iova() const;
private:
    PagePool* pool_;

    DmaView data_;
    std::uint32_t free_page_idx_;
};
```

Therefore this really is a view into the page(s) of allocation.

Important bit is that in destructor of `PageAllocation`, it will call `release(*this)` to its parent page pool to tie lifetime into destruction of this view. Note that destruction of the view and resource deallocation are different things, and we are not doing what we were trying to avoid in the first place.

## Conclusion

This is a really, really simple implementation of a memory allocator and there are more complicated (and better) techniques out there, but this was simple enough to suit my needs for the time being. I plan to concern about performance after I'm done with a working base that I am happy with, so I will probably revisit this in the future.

Next chapter will probably be on writing host only unit tests for the driver.

Pretty much my roadmap will be like:
- Unit tests
- PRP list for multi page IO
- Make controller lifecycle more explicit with a state machine (will help with recovery as well)
- and make code better idk

