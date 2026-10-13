import { Fragment, type ReactNode } from "react";

/** Renders the bundled agreement (small markdown subset) with hanging clause numbers. */
export function LegalText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  let docIndex = 0;
  const out: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (b.startsWith("# ")) {
      const id = docIndex++ === 0 ? "legal-eula" : "legal-privacy";
      out.push(<h2 key={i} id={id} className="hc-legal__doc-title">{b.slice(2)}</h2>);
    } else if (b.startsWith("## ")) {
      out.push(<h3 key={i} className="hc-legal__chapter">{b.slice(3)}</h3>);
    } else if (b.startsWith("### ")) {
      out.push(<h4 key={i} className="hc-legal__clause-title">{b.slice(4)}</h4>);
    } else {
      const m = b.match(/^(\d+\.\d+\.)\s+([\s\S]*)$/);
      out.push(m ? (
        <p key={i} className="hc-legal__clause"><span className="hc-legal__num">{m[1]}</span><span>{m[2]}</span></p>
      ) : (
        <p key={i} className="hc-legal__para">{b.split("\n").map((l, j) => <Fragment key={j}>{j > 0 && <br />}{l}</Fragment>)}</p>
      ));
    }
  });
  return <div className="hc-legal__text">{out}</div>;
}
