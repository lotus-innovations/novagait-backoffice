"use client";

import { TOUR_LAUNCH_LABEL } from "./steps";
import { writeState } from "./tour-state";

export default function TourLaunchButton({
  label = TOUR_LAUNCH_LABEL,
}: {
  label?: string;
}) {
  return (
    <button
      type="button"
      className="tour-launch"
      onClick={() => writeState({ active: true, index: 0 })}
    >
      {label}
    </button>
  );
}
