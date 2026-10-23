export default function EmptyState({ icon = '∅', title, description, action = null }) {
  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty__icon" aria-hidden="true">
        {icon}
      </div>
      <p className="empty__title">{title}</p>
      {description ? <p className="empty__description">{description}</p> : null}
      {action}
    </div>
  );
}