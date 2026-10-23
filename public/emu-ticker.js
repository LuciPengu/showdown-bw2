// Ticks 60 times a second for emu-boot.js. Timers in a worker keep running
// at full speed while the page is hidden; the page's own timers don't.
setInterval(() => postMessage(0), 1000 / 60);
