// Run Swift on the page's main thread: the WebUSB chooser and the file picker need the
// click's user activation, which a call forwarded from a worker may no longer carry.
globalThis.__renderWorker = false;
