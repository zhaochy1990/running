# PR related operations

if no argument provided, then first check if the remote has a pr opened for current branch, if not create the PR with current branch.

if the argument 'complete' is given, complete the pr if no merge conflict and all ci checks pass.

if the argument 'status' is given, output the PR link and use git status to give a brief summary of what we already done in the PR.

