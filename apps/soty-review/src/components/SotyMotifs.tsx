export function SotyMotifs() {
  return (
    <div className="soty-motifs" aria-hidden="true">
      <div className="soty-tech-cells">
        {Array.from({ length: 20 }, (_, index) => (
          <span className={`soty-tech-cell is-${(index % 5) + 1}`} key={index} />
        ))}
      </div>
    </div>
  );
}
