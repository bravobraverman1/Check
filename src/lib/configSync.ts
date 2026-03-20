/**
 * configSync.ts
 * ─────────────
 * A singleton Supabase Realtime broadcast channel that stays connected for the
 * lifetime of the app. Because the channel is always subscribed, sends are
 * immediate — no create/subscribe/destroy cycle that causes timing issues.
 *
 * Usage:
 *   import { broadcastConfigChange, onConfigChange } from "@/lib/configSync";
 *
 *   // Send (Admin page after saving)
 *   broadcastConfigChange("tab-names-saved", { tabValues });
 *
 *   // Receive (App.tsx — global listener)
 *   onConfigChange((event, payload) => { ... });
 */

import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

type ConfigChangeHandler = (event: string, payload: Record<string, unknown>) => void;

const CHANNEL_NAME = "app-config-sync";

let _channel: RealtimeChannel | null = null;
const _handlers: ConfigChangeHandler[] = [];

function getChannel(): RealtimeChannel {
  if (_channel) return _channel;

  _channel = supabase
    .channel(CHANNEL_NAME, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "*" }, (msg) => {
      for (const handler of _handlers) {
        handler(msg.event, (msg.payload ?? {}) as Record<string, unknown>);
      }
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[configSync] channel connected");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.warn("[configSync] channel disconnected:", status);
        // Clear so next call to getChannel() re-creates it
        _channel = null;
      }
    });

  return _channel;
}

// Initialise the channel eagerly on module load
getChannel();

/**
 * Broadcast a config change event to all other connected clients.
 * Fire-and-forget — errors are logged but not thrown.
 */
export function broadcastConfigChange(
  event: string,
  payload: Record<string, unknown> = {}
): void {
  const ch = getChannel();
  ch.send({ type: "broadcast", event, payload }).catch((err) => {
    console.warn("[configSync] broadcast failed:", err);
  });
}

/**
 * Register a handler to be called whenever any config change event arrives
 * from another client. Returns an unsubscribe function.
 */
export function onConfigChange(handler: ConfigChangeHandler): () => void {
  _handlers.push(handler);
  // Ensure the channel is active
  getChannel();
  return () => {
    const idx = _handlers.indexOf(handler);
    if (idx >= 0) _handlers.splice(idx, 1);
  };
}
