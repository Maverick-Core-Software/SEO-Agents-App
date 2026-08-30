export function StatusChip({ label, color }) {
  return (
    <span className="statusChip" style={{ backgroundColor: color }}>
      {label}
    </span>
  );
}
