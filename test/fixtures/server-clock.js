// Test-only wall-clock control, loaded through Node --import in a private child.
const now = Date.now;
let offset = 0;
Date.now = () => now() + offset;
process.on('message', message => {
  if (message?.type !== 'advance-clock') return;
  offset += message.milliseconds;
  process.send?.({ type: 'clock-advanced' });
});
