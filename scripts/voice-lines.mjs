// Records Gorran's lines with ElevenLabs, skipping lines already recorded and deleting recordings no line uses.
// Usage: node --env-file=.env.local scripts/voice-lines.mjs   (reads src/game/lines.ts, writes public/audio/voice)
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { LINES, voiceFile } from '../src/game/lines.ts';

const VOICE = 'xE7yWnwE68Kdjx41qhjS';
const DIR = 'public/audio/voice';
// eleven_v3 acts out a leading audio tag without speaking it.
const DELIVERY = [
  [LINES.shove, '[sighs]'],
  [LINES.unmoved.calm, '[bored]'],
  [LINES.unmoved.enraged, '[angry]'],
  [LINES.mood.enraged, '[angry]'],
  [LINES.mood.calm, '[calmly]'],
  [LINES.won, '[chuckles]'],
];

mkdirSync(DIR, { recursive: true });
const files = new Map(DELIVERY.flatMap(([lines, tag]) => lines.map((line) => [`public/${voiceFile(line)}`, `${tag} ${line}`])));
for (const file of readdirSync(DIR)) if (!files.has(`${DIR}/${file}`)) rmSync(`${DIR}/${file}`);
for (const [file, text] of files) {
  if (existsSync(file)) continue;
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_v3' }),
  });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status} ${await response.text()}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  console.log(file);
}
