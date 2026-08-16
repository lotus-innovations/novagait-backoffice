"use client";

import { useSyncExternalStore } from "react";
import { TOUR_LAUNCH_LABEL } from "./steps";
import { writeState } from "./tour-state";

/** Never fires; the snapshots alone tell us server from client. */
const noopSubscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

export default function TourLaunchButton({
  label = TOUR_LAUNCH_LABEL,
}: {
  label?: string;
}) {
  // This button is server-rendered HTML, so it is on screen and tappable
  // before the client bundle hydrates and its onClick exists. Measured on a
  // throttled mobile connection against production: a tap at DOM-ready and a
  // tap at 300ms both did nothing at all, silently, and only a tap at 1500ms
  // started the tour. That is the visitor's FIRST interaction with the
  // feature, so a dropped tap is the worst possible place for one.
  //
  // useSyncExternalStore rather than an effect: it gives a truthful
  // server/client split without a setState in an effect body.
  const hydrated = useSyncExternalStore(noopSubscribe, onClient, onServer);

  return (
    <button
      type="button"
      className="tour-launch"
      disabled={!hydrated}
      onClick={() => writeState({ active: true, index: 0 })}
    >
      {label}
    </button>
  );
}
