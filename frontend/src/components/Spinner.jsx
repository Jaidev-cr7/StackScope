export default function Spinner({ label = 'Loading', size = 'md', inline = false }) {
  const spinner = (
    <span
      className={`spinner${size === 'md' ? '' : ` spinner--${size}`}`}
      data-testid="spinner"
      role="status"
      aria-live="polite"
      aria-label={label}
    />
  );
  if (inline) {
    return (
      <span className="row">
        {spinner}
        <span>{label}</span>
      </span>
    );
  }
  return spinner;
}

export function LoadingBlock({ label = 'Loading…' }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <Spinner size="lg" label={label} />
      <span>{label}</span>
    </div>
  );
}