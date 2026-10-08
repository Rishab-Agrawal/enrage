const DEEPGRAM = 'wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&keyterm=Gorran&keyterm=Wren';
/** How often the recorder hands audio to the socket, ms. */
const CHUNK = 100;

type Result = { type: string; is_final?: boolean; channel?: { alternatives: { transcript: string }[] } };

/**
 * Speech-to-text for push-to-talk: streams the mic to Deepgram while held, so the transcript is ready as soon as she lets go.
 * Audio recorded before the socket opens is queued, so no words are lost to the connection.
 */
export class Speech {
  /** Asked for once, then kept open: a fresh request each press would clip her first words. */
  private mic?: Promise<MediaStream>;
  private letGo?: () => void;

  constructor(private readonly onHeard: (text: string) => void) {}

  /** Follow the push-to-talk state: a turn starts when it goes true and ends when it goes false. */
  hold(on: boolean): void {
    if (on && !this.letGo) {
      const released = new Promise<void>((resolve) => (this.letGo = resolve));
      this.listen(released).then(this.onHeard, (error) => console.warn('Speech-to-text failed:', error));
    } else if (!on && this.letGo) {
      this.letGo();
      this.letGo = undefined;
    }
  }

  private async listen(released: Promise<void>): Promise<string> {
    this.mic ??= navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(await this.mic);
    const queued: Blob[] = [];
    let send: (chunk: Blob) => void = (chunk) => queued.push(chunk);
    recorder.ondataavailable = (event) => send(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start(CHUNK);
    void released.then(() => recorder.stop());

    const grant = await fetch('/api/stt-token');
    if (!grant.ok) throw new Error(`token: HTTP ${grant.status}`);
    const { access_token } = (await grant.json()) as { access_token: string };
    // Browsers can't set headers on a WebSocket: Deepgram takes the token as the subprotocol.
    const socket = new WebSocket(DEEPGRAM, ['bearer', access_token]);
    const heard: string[] = [];
    socket.onmessage = (event) => {
      const result = JSON.parse(event.data) as Result;
      if (result.type === 'Results' && result.is_final) heard.push(result.channel!.alternatives[0].transcript);
    };
    const closed = new Promise((resolve) => (socket.onclose = resolve));
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('socket failed to open'));
    });
    for (const chunk of queued) socket.send(chunk);
    send = (chunk) => socket.send(chunk);
    await stopped;
    // Deepgram flushes the last results, then closes.
    socket.send(JSON.stringify({ type: 'CloseStream' }));
    await closed;
    return heard.filter(Boolean).join(' ');
  }
}
