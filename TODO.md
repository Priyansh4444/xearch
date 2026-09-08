# TODO 

- [ ] make all errors typed using effect
- [ ] move FxTwitterClient to a struct with shared functions and using Effect's clean mechanism for retries, backoff, concurrency and schema validation
- [ ] alot of strings literals that are being shared and used in if conditions, are being used across the code base and this is causing typesafety issues and unhandled cases, an enum feels like the right job since as soon as you add a case you should get a lint error for an unhandled enum case
- [ ] please run cargo next for effective benchmarking
- [ ] there is a lot of outdated code including things in R2 which are no longer being used please remove it. but do not get rid of convex and it's TODOs
- [ ] there is a lot of destructuring happening, be careful a lot of these are not causing heap churn with respect to js and similarly with closures.
- [ ] Try migrating more and more parts to effect after reading the effect documentation, especially for schema validation and handling effective 

### Things that should be it's own PR/Stacked PR
- [ ] Attempt builing a Xquery client. Take heavy inspiration from other vendors
- [ ] Attempt building a simpler non Xquery client which is just raw for search
- [ ] Finishing out Convex Engine
- [ ] Simplifying the Data Structures and Tables to be MATHEMATICALLY the most efficient for retrieval
