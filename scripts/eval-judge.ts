// Runs the judge on every case in evals/cases.json as a LangSmith experiment, on a dataset kept in step with the file.
import { readFileSync } from 'node:fs';
import { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';
import { judge, type Turn } from '../server/judge.ts';

const DATASET = 'enrage-judge';
const cases: (Turn & { turns: boolean })[] = JSON.parse(readFileSync('evals/cases.json', 'utf8'));

const client = new Client();
if (!(await client.hasDataset({ datasetName: DATASET }))) await client.createDataset(DATASET);
// Examples match cases by content: add the cases new to the file, delete the examples gone from it.
const key = (mood: unknown, worked: unknown, newest: unknown, turns: unknown) => JSON.stringify([mood, worked, newest, turns]);
const added = new Map(
  cases.map(({ mood, worked, newest, turns }) => [key(mood, worked, newest, turns), { inputs: { mood, worked, newest }, outputs: { turns }, dataset_name: DATASET }]),
);
const gone: string[] = [];
for await (const { id, inputs, outputs } of client.listExamples({ datasetName: DATASET })) {
  if (!added.delete(key(inputs.mood, inputs.worked, inputs.newest, outputs?.turns))) gone.push(id);
}
if (gone.length) await client.deleteExamples(gone);
if (added.size) await client.createExamples([...added.values()]);

const results = await evaluate(async (inputs) => ({ turns: await judge(inputs as Turn) }), {
  data: DATASET,
  evaluators: [
    ({ outputs, referenceOutputs }: { outputs: Record<string, unknown>; referenceOutputs?: Record<string, unknown> }) => ({
      key: 'correct',
      score: outputs.turns === referenceOutputs?.turns,
    }),
  ],
  experimentPrefix: 'jev',
  maxConcurrency: 4,
});
const wrong = results.results.filter((row) => !row.evaluationResults.results[0]?.score);
for (const { example } of wrong) console.log('Wrong:', JSON.stringify({ ...example.inputs, ...example.outputs }));
console.log(`${results.length - wrong.length}/${results.length} right.`);
