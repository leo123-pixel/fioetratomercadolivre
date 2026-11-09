/** Destaca a primeira ocorrência de `emphasis` dentro do texto (cor dourada da marca). */
export function Emphasis({ text, emphasis, className }: { text: string; emphasis?: string; className?: string }) {
  const index = emphasis ? text.indexOf(emphasis) : -1;
  if (!emphasis || index < 0) return <>{text}</>;
  const Tag = className ? "span" : "em";
  return (
    <>
      {text.slice(0, index)}
      <Tag className={className}>{emphasis}</Tag>
      {text.slice(index + emphasis.length)}
    </>
  );
}
