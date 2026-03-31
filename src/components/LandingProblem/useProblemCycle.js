export default function useProblemCycle(scrollFraction, totalSteps = 4) {
  const stepSize = 1 / totalSteps;
  const raw = scrollFraction / stepSize;
  const activeIndex = Math.min(Math.floor(raw), totalSteps - 1);
  const stepProgress = raw - Math.floor(raw);
  return { activeIndex, stepProgress };
}
