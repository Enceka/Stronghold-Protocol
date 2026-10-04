// node tools/matchrun.mjs --mode solo --difficulty FUNNY --ai ./examples/ai/my-policy.mjs --seeds 3 --check
// A small user policy: select the available strategy with the most starting LP, then delegate the complex prep.
// memory is private to this seat and persists across decisions. Returning null continues with the existing bot.
export function decide({ observation, actions, record, memory }) {
  memory.decisions = (memory.decisions || 0) + 1;
  if (observation.public.phase === 'BAND_DRAFT') {
    return actions({ placements: false })
      .filter((a) => a.t === 'g.band')
      .sort((a, b) => (record('bands', b.bandId)?.totalHp || 0) - (record('bands', a.bandId)?.totalHp || 0))[0] || null;
  }
  return null;
}
