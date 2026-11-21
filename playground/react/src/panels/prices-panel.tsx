// src/panels/prices-panel.tsx
//
// The price tiles. The WebSocket of the workspace feeds them. The library wraps the WebSocket
// (capture.webSocket), counts its messages, and the price handler logs each tick at DEBUG in
// the noisy namespace market.prices, which the sampling setting can thin out.

import type { ReactElement } from "react";
import { PAIRS } from "../api/types";
import { useMarket } from "../data/market-store";

const ARROWS = { up: "▲", down: "▼", flat: "▬" } as const;

/**
 * Renders one tile for each pair, and the tick rate of the stream.
 * @returns The panel.
 */
export function PricesPanel(): ReactElement {
  const { prices, ticksPerSecond } = useMarket();

  return (
    <section className="panel" aria-label="Prices">
      <p className="muted">
        Ticks per second: <strong>{ticksPerSecond ?? "-"}</strong>. The library sends the same value
        as the gauge <code>market.tick_rate</code>.
      </p>
      <div className="tiles">
        {PAIRS.map((pair) => {
          const tile = prices[pair];

          return (
            <div key={pair} className="tile" data-direction={tile?.direction ?? "flat"}>
              <h3>{pair}</h3>
              <p className="tile-price">
                <span className="muted">Bid</span> <strong>{tile ? tile.bid : "-"}</strong>
              </p>
              <p className="tile-price">
                <span className="muted">Ask</span> <strong>{tile ? tile.ask : "-"}</strong>
              </p>
              <p className="tile-arrow" aria-hidden="true">
                {ARROWS[tile?.direction ?? "flat"]}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
