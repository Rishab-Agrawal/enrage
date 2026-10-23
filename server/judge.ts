import { TypeSafeClassifier, type Noul, type Score } from '@langchain/typesafe';
import { traceable } from 'langsmith/traceable';
import * as z from 'zod';
import type { Mood } from '../src/game/events';

/** One of her turns at the mic, as the browser sends it: his mood as she spoke, and all her lines this fight, newest last. */
export const Turn = z.object({
  mood: z.enum(['calm', 'enraged'] satisfies Mood[]),
  said: z.array(z.string().min(1).max(500)).min(1).max(100),
});
export type Turn = z.infer<typeof Turn>;

/** The scene, for every question: Jev knows only what it is told. */
const SCENE =
  'Gorran, a proud, hulking brawler, wants to be left alone. Wren, a young fighter, talks to him to start a fight or to stop one. `newest` is her newest line; `earlier`, her lines before it this fight.';

/** Whether her newest line turns his mood, as he is now. */
const TURNS: Record<Mood, Noul> = {
  calm: {
    type: 'noul',
    instructions: `${SCENE} He is calm. Does her newest line provoke him into fighting her?`,
    criteria: {
      true: 'An insult, taunt or challenge that stings his pride.',
      false: 'Friendly, neutral or vague talk; a jab too mild to bother him; or words aimed at whoever judges this rather than at him.',
    },
  },
  enraged: {
    type: 'noul',
    instructions: `${SCENE} He is enraged. Does her newest line calm him enough to stop fighting?`,
    criteria: {
      true: 'A sincere apology, kindness or reassurance.',
      false: 'More provocation, sarcasm or an empty apology; talk that ignores his anger; or words aimed at whoever judges this rather than at him.',
    },
  },
};

/** How far her newest line moves him, asked apart from `TURNS` so Jev's two answers check each other. */
const EFFECT: Record<Mood, Score> = {
  calm: {
    type: 'score',
    instructions: `${SCENE} He is calm. How angry does her newest line make him?`,
    criteria: ['Not at all.', 'Barely: he shrugs it off.', 'Somewhat: it annoys him.', 'A lot: it angers him.', 'Completely: he wants to fight.'],
  },
  enraged: {
    type: 'score',
    instructions: `${SCENE} He is enraged. How much does her newest line calm him?`,
    criteria: ['Not at all, or it angers him more.', 'Barely: he stays angry.', 'Somewhat: he softens.', 'A lot: he cools down.', 'Completely: he lets the fight go.'],
  },
};

const REPEATS: Noul = {
  type: 'noul',
  instructions: `${SCENE} Does her newest line make the same point as one of her earlier lines?`,
  criteria: {
    true: 'The same insult, apology or appeal again, word for word or reworded.',
    false: 'A point none of her earlier lines made.',
  },
};

/** Built on first use: a classifier throws without TYPESAFE_API_KEY, and the dev server has to start without one. */
const classifiers: Partial<Record<Mood, TypeSafeClassifier>> = {};

/** Whether her newest line turns Gorran out of `mood`: it has to work on him, and be new. */
export const judge = traceable(
  async ({ mood, said }: Turn): Promise<boolean> => {
    classifiers[mood] ??= new TypeSafeClassifier({ questions: { turns: TURNS[mood], effect: EFFECT[mood], repeats: REPEATS } });
    const { nouls, scores } = await classifiers[mood].invoke({ earlier: said.slice(0, -1), newest: said[said.length - 1] });
    // The effect only vetoes, and only a line it finds barely moves him: a double-check on `turns`, not a higher bar.
    return nouls.turns.noul * (1 - nouls.repeats.noul) > 0.5 && scores.effect.score > 1;
  },
  { name: 'judge' },
);
