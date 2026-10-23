// キーの表示。"⌘/Ctrl + Shift + L" や "R / V" を、キーごとの <kbd> に分けて並べる。
// " / " は「または」、" + " は「同時に押す」。キーそのものが "/" や "+" のときはそのまま 1 つのキーにする。
import { Fragment } from "react";

export function KeyCombo({ keys }: { keys: string }) {
  const alts = keys.split(" / ");
  return (
    <span className="key-combo">
      {alts.map((alt, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="key-sep"> / </span>}
          {alt.split(" + ").map((k, j) => (
            <Fragment key={j}>
              {j > 0 && <span className="key-plus">+</span>}
              <kbd>{k}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
