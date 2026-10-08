/** What Gorran says: one line of a set, at random. */
export const LINES = {
  /** Shoving her off while calm. */
  shove: ['Please go away.', 'Leave me alone.', 'I don’t want a fight.'],
  /** Her words leave his mood as it was. */
  unmoved: {
    calm: ['Whatever.', 'If you say so.', 'Hm.'],
    enraged: ['Not so easy.', 'I don’t care.', 'I’m still angry!', 'Saying that won’t help you.'],
  },
  /** His mood turns. */
  mood: {
    enraged: ['That’s enough!', 'You’ve crossed the line!', 'Get ready to lose.', 'How dare you say that?'],
    calm: ['Alright, I’ll spare you for now.', 'You’re lucky I believe you.'],
  },
  /** He beat her. */
  won: ['I feel better now.', 'Done and dusted.', 'Be quiet next time.'],
};
