import React, { useEffect, useState } from 'react';
import type { PaperOrder, PaperPosition } from '@regardedtrader/core';
import { AiDisclaimer } from '../components/AiDisclaimer.js';

export interface PaperRouteProps {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  onClose?: () => void;
}

export function Paper(props: PaperRouteProps): JSX.Element {
  const f = props.fetchImpl ?? fetch;
  const base = props.apiBase ?? '/api';
  const [orders, setOrders] = useState<PaperOrder[] | null>(null);
  const [positions, setPositions] = useState<PaperPosition[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      f(`${base}/paper/orders`).then(async (r) => (r.ok ? (await r.json()) as { orders: PaperOrder[] } : Promise.reject(new Error(`HTTP ${r.status}`)))),
      f(`${base}/paper/positions`).then(async (r) => (r.ok ? (await r.json()) as { positions: PaperPosition[] } : Promise.reject(new Error(`HTTP ${r.status}`)))),
    ])
      .then(([o, p]) => {
        setOrders(o.orders);
        setPositions(p.positions);
      })
      .catch((e) => setErr(String(e)));
  }, [f, base]);

  return (
    <div className="min-h-screen bg-app text-fg">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Paper trading</h1>
          {props.onClose && (
            <button type="button" onClick={props.onClose} className="text-xs text-fg-muted hover:text-fg-secondary">
              ← back
            </button>
          )}
        </header>

        <div className="border border-warn text-warn rounded px-3 py-2 text-xs">
          <strong>PAPER — simulated, no real orders.</strong> This surface only displays local simulated fills/positions.
        </div>

        {err && (
          <div role="alert" className="text-xs text-down">
            {err}
          </div>
        )}

        {!err && (!orders || !positions) && (
          <div className="text-xs text-fg-muted">Loading paper data…</div>
        )}

        {orders && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Orders</h2>
            {orders.length === 0 ? (
              <div className="text-xs text-fg-muted">No paper orders yet.</div>
            ) : (
              <table className="w-full text-xs border border-border-subtle rounded overflow-hidden">
                <thead className="bg-surface text-fg-muted">
                  <tr>
                    <th className="text-left px-2 py-1">Plan ID</th>
                    <th className="text-left px-2 py-1">Symbol</th>
                    <th className="text-left px-2 py-1">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-t border-border-subtle">
                      <td className="px-2 py-1 num">{o.planId}</td>
                      <td className="px-2 py-1">{o.symbol}</td>
                      <td className="px-2 py-1 num">{o.submittedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {positions && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Positions</h2>
            {positions.length === 0 ? (
              <div className="text-xs text-fg-muted">No paper positions yet.</div>
            ) : (
              <table className="w-full text-xs border border-border-subtle rounded overflow-hidden">
                <thead className="bg-surface text-fg-muted">
                  <tr>
                    <th className="text-left px-2 py-1">Plan ID</th>
                    <th className="text-left px-2 py-1">Symbol</th>
                    <th className="text-right px-2 py-1">Net premium</th>
                    <th className="text-right px-2 py-1">Max loss</th>
                    <th className="text-left px-2 py-1">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id} className="border-t border-border-subtle">
                      <td className="px-2 py-1 num">{p.planId}</td>
                      <td className="px-2 py-1">{p.symbol}</td>
                      <td className="px-2 py-1 text-right num">${p.netPremiumUsd.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right num">${p.maxLossUsd.toFixed(2)}</td>
                      <td className="px-2 py-1 num">{p.openedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        <AiDisclaimer />
      </div>
    </div>
  );
}

