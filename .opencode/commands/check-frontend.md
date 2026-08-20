---
description: check frontend API usage
---

Check the frontend UI, get all APIs it depends on. Then you need to check the Dockerfile to get the env vars that alrady cutoff trafic to go.

use these modules to catogory these APIs,
1. master plan
2. weekly plan
3. teams
4. 体测
5. user profile
6. data sync
7. coach chat
8. training load
9. activities
10. others

For each category, use a table to show me the results. I want to have 3 columns in the table, 
1. the API
2. current backend, (go or python)
3. is go API ready