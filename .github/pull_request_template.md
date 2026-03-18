## :information_source: Important:
- Ensure the PR subject clearly reflects the scope of the changes.
- Before submitting for review, verify that the macros being modified are enabled in `run_grants.sql`.
- All other macros in `run_grants.sql` must be disabled—except grant_core_roles and grant_functional_roles by commenting them out using the {# your_macro_name #} format to prevent execution if other macros are not modified in your PR.
- Please remove the above text from this line before submitting for review.
## ServiceNow: 
[RequestNumber/JiraNumber/NA](RITM URL/Jira URL/or # if no ticket available) 
## Justification: 
Write justification here

---
- [ ] I confirm that the dbt job run_grants includes the necessary fix in the event of a failure.
