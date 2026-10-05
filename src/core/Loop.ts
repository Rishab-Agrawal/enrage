export class Loop {
  private frameId = 0;
  private lastTime = 0;
  private running = false;

  constructor(
    private readonly update: (deltaSeconds: number, elapsedSeconds: number) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (time: number) => {
    if (!this.running) return;
    // A frame's timestamp can predate start(), so the first delta may come out negative.
    const deltaSeconds = Math.max(0, Math.min((time - this.lastTime) / 1000, 0.05));
    this.lastTime = time;
    this.update(deltaSeconds, time / 1000);
    this.render();
    this.frameId = requestAnimationFrame(this.tick);
  };
}
