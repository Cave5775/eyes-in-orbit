/** One label/value pair of a `dl.kv` grid; renders nothing for missing values. */
export function Field({ label, value, mono = false, tone }: { label: string; value: string | number | null | undefined; mono?: boolean; tone?: string }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd className={`${mono ? 'mono' : ''} ${tone ?? ''}`}>{value}</dd>
    </>
  );
}
