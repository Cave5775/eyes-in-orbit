/**
 * One label/value pair of a `dl.kv` grid; renders nothing for missing values.
 * `mono` marks a numeric value (single line, tabular digits, ellipsis); `wrap` allows breaking
 * anywhere for long ids and URLs.
 */
export function Field({ label, value, mono = false, wrap = false, tone }: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
  wrap?: boolean;
  tone?: string;
}) {
  if (value === undefined || value === null || value === '') return null;
  const cls = [mono ? 'mono' : '', mono && !wrap ? 'num' : '', wrap ? 'wrap' : '', tone ?? ''].filter(Boolean).join(' ');
  return (
    <>
      <dt>{label}</dt>
      <dd className={cls} title={mono && !wrap ? String(value) : undefined}>{value}</dd>
    </>
  );
}
