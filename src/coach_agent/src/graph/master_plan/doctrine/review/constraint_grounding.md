# Constraint Grounding Rubric v1

Score 1-5 for: goal_fidelity, availability_fit, evidence_grounding, selected_strategy_fidelity.
Block when the plan changes the confirmed goal, violates explicit availability/prohibitions, or ignores a safety constraint.
Treat unavailable days as prohibitions on routine training. The confirmed goal race is a fixed event on its supplied race date, so its race-day load is not an availability violation; non-race load must still remain on available days.
Revise for material grounding gaps; warning for non-blocking ambiguity.
Every issue must cite supplied fact IDs and a JSON-pointer target path.
