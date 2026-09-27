# Build log

## What I set out to do

I wanted to build a small money transfer API where the important rules stayed correct even under failure and concurrency: balances could never go negative, transfers had to be atomic, retries could not move money twice, and all amounts had to stay exact.

I built the project incrementally and tested each stage before moving on. One thing I deliberately did was build the transfer flow first with database transactions but without concurrency locking. That gave me a broken version I could actually measure. With two concurrent 80.00 transfers from a 100.00 balance, I saw 500 errors in 49 of 50 rounds, and opposite A↔B transfers produced 92 deadlocks out of 100. After adding deterministic row locking, the same tests gave the expected results with no deadlocks.

## Where AI genuinely helped

AI was most useful when I used it to explore designs and build experiments, rather than just accepting generated code.

It helped me understand and test the concurrency behaviour around `FOR UPDATE`, deterministic lock ordering and idempotency locks. I asked it to explain why the locking worked, then verified the explanation by breaking the code and rerunning the same race tests.

It was also useful for writing small throwaway probes. For example, instead of just assuming that lock ordering mattered, I tested versions with source-first locking, no `ORDER BY`, and deterministic `ORDER BY id`. That made the deadlock behaviour visible rather than theoretical.

I also used AI for mutation testing. After tests passed, I intentionally removed important protections such as the lock order or the guarded debit and checked that the tests actually failed.

## Where AI was wrong, and how I caught it

AI confidently told me that `btrim(name)` would reject whitespace-only names. That was not true: PostgreSQL's default `btrim` only handled normal spaces, so inputs containing other whitespace could still get through. I caught that with a direct database probe. Its first fix also escaped the characters incorrectly and caused valid values such as `Commit` to be rejected. A test exposed that.

It also told me that the transaction-history indexes meant the query would not need a sort. I checked the actual query plan with `EXPLAIN` and found that PostgreSQL used both indexes, but still sorted the matching rows after combining them.

Some generated tests were also weaker than they looked. One concurrency test passed even after I removed the idempotency lock because the connection pool was still warming up and the requests did not overlap enough. Running several rounds exposed the problem. Another test for `"100"` versus `"100.00"` only covered one order and therefore did not actually prove that numeric-equivalent amounts were treated the same. I strengthened both tests after mutation testing showed the gaps.


## What I changed or rejected

I did not keep every suggestion AI gave me.

AI originally suggested making `starting_balance` optional and defaulting it to zero. I wanted account creation to require an explicit opening amount, so I made the field mandatory and required it to be positive.

It also suggested storing money as `BIGINT` cents. I preferred PostgreSQL `NUMERIC(20,2)` because it kept the value readable and exact in the database and avoided extra conversion logic between cents and decimal amounts.

I rejected accepting JSON numbers for monetary values as well. Rather than adding more checks around JavaScript number precision, I made money inputs string-only so the client representation stays exact.

For transaction history, AI proposed cursor pagination with timestamp precision handling and tie-breakers. I understood why it worked, but I decided it was more complexity than this assignment needed. I kept a simple bounded `limit` instead.

I also chose not to do some cleanup work that did not improve correctness, such as merging validation files or adding a health endpoint.

One AI suggestion that I did keep was the advisory lock for idempotency. My initial thought was to rely mainly on the unique idempotency key, but after reasoning through concurrent retries I saw that a retry could otherwise hit `insufficient_funds` before reaching the duplicate insert. The advisory lock made the replay behaviour much cleaner, so I kept it after verifying it with concurrent tests.

The `Idempotency-Key` header was originally optional, and AI had even written up reasons for keeping it that way. When I reviewed the finished project against the brief, I realised that conflicted with the rule that the same transfer submitted twice is only applied once: without a key, two identical requests moved the money twice, because the server cannot tell a retry from a second intentional transfer. I made the header required, so a transfer without one is rejected with a 400, and I replaced the test that allowed unkeyed duplicates with one that proves they are refused.

## What I shipped but would improve

There is no authentication, so any caller who knows an account ID can move money from it.

Idempotency keys are global and never expire. In a larger system I would scope them to a user or account and add retention.

Failed requests do not permanently reserve their idempotency key, so the same key can later be reused for a different request. That is consistent with this implementation, but I would want to define that behaviour more explicitly in a production API.

The concurrency tests use real timing and connection overlap. Running several rounds makes them much more reliable, but they are still not a perfect deterministic concurrency harness.

Most of the implementation was AI-assisted, but I treated generated code as a starting point rather than as proof of correctness. The biggest issues I found were caught by direct probes, race tests and mutation testing, not by simply reading the generated code.
