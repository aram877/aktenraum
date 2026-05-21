type Props = {
  position: number;
  total: number;
  canNavigate: boolean;
  onPrev: () => void;
  onNext: () => void;
  prevTitle?: string;
  nextTitle?: string;
};

export function NeighborNav({
  position,
  total,
  canNavigate,
  onPrev,
  onNext,
  prevTitle = "Vorheriges (K)",
  nextTitle = "Nächstes (J)",
}: Props) {
  const buttonCls =
    "inline-flex h-9 w-9 items-center justify-center rounded-md border border-hairline bg-surface text-ink-muted hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 sm:h-7 sm:w-7";
  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={onPrev}
        disabled={!canNavigate}
        title={prevTitle}
        aria-label={prevTitle}
        className={buttonCls}
      >
        <span aria-hidden>←</span>
      </button>
      <span className="select-none text-xs text-ink-subtle">
        {position >= 0 ? `${position + 1} / ${total}` : `— / ${total}`}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!canNavigate}
        title={nextTitle}
        aria-label={nextTitle}
        className={buttonCls}
      >
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}
