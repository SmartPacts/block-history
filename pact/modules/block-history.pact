;; block-history.pact — an append-only, engine-attested record of this chain's blocks.
;;
;; WHY IT EXISTS. Inside Pact, (chain-data) is the only window onto the chain, and it
;; describes the PREVIOUS block: in the block at height N, `prev-block-hash` is the hash
;; of block N-1 and `block-time` is block N-1's creation time. So a transaction mined in
;; block N can write down a complete record of block N-1 using values it was handed by
;; the engine — nobody chose them, nobody can forge them. One block later that window is
;; gone for good. This module is the writing down.
;;
;; TWO TABLES, TWO TRUST LEVELS — NEVER MIXED.
;;   attested    rows written by `attest`. It takes NO arguments: key and value both come
;;               from (chain-data), so a caller decides only WHETHER a row is written,
;;               never what it says. Unforgeable, and reorg-safe by construction (a
;;               recording transaction lives on the same fork as the block it records).
;;   backfilled  rows written by `backfill` under the backfill keyset, for blocks that
;;               were never attested. These are TRUSTED at write time — the platform has
;;               no way to verify a historical block hash in-contract — and publicly
;;               auditable forever against the node's own headers. The window can be
;;               closed once, permanently. A height lives in at most ONE of the tables.
;;
;; IMMUTABLE FROM ITS FIRST DEPLOY. GOVERNANCE can never be satisfied, so no later code
;; can rewrite, reinterpret or delete a row. Pact has no row delete, so every row is
;; permanent by nature; this module makes the code as permanent as the data.
;;
;; WHAT TO SETTLE ON. `hash` is a consensus commitment the miner cannot forge. `time` is
;; the creation time the block's miner stamped, so it can drift by a few seconds — treat
;; it as metadata and express deadlines as heights. The value a row WILL contain is
;; public one full block before it is written, so this is a provenance record, not a
;; randomness beacon: a consumer that draws from it must commit to a height BEFORE that
;; block exists.

(namespace (read-msg 'ns))

(module block-history GOVERNANCE
  ;; SPDX-License-Identifier: Apache-2.0

  @doc "Append-only record of this chain's blocks: height -> {hash, time, by}. \
  \`attest` writes the previous block from engine-supplied values and can never be \
  \wrong; `backfill` writes older blocks under a keyset, into a separate table, until \
  \the window is closed. The module cannot be upgraded."

  ;; ---------------------------------------------------------------------------
  ;; Immutability. Governance is not evaluated on a first deploy, so this installs;
  ;; it can never be satisfied afterwards: no upgrade, no external table write, no
  ;; `acquire-module-admin`.
  ;; ---------------------------------------------------------------------------
  (defcap GOVERNANCE ()
    (enforce false "block-history is immutable: it can never be upgraded"))

  ;; ---------------------------------------------------------------------------
  ;; Constants
  ;; ---------------------------------------------------------------------------
  ;; The backfill keyset lives beside the module in the namespace it was deployed into.
  (defconst BACKFILL-KS (format "{}.block-history-backfill" [(read-msg 'ns)]))
  ;; Row keys are zero-padded to 12 digits so an external key listing sorts numerically.
  (defconst KEY-WIDTH 12)
  (defconst ZEROS "000000000000")
  (defconst MAX-HEIGHT 1000000000000)
  ;; The unpadded base64url alphabet a chainweb block hash is written in (43 chars).
  (defconst B64URL "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
  (defconst HASH-LENGTH 43)
  (defconst EPOCH (time "1970-01-01T00:00:00Z"))

  ;; ---------------------------------------------------------------------------
  ;; Schemas and tables
  ;; ---------------------------------------------------------------------------
  (defschema block
    @doc "One block. `by` is the gas-paying account of the recording transaction — \
    \informational only, never an authority."
    hash:string
    time:time
    by:string)

  (defschema block-in
    @doc "One backfill row as supplied in transaction data."
    height:integer
    hash:string
    time:time)

  (defschema latest-row height:integer hash:string time:time)
  (defschema window open:bool closed-at:integer)

  (deftable attested:{block})
  (deftable backfilled:{block})
  (deftable latest-tbl:{latest-row})
  (deftable backfill-window:{window})

  ;; ---------------------------------------------------------------------------
  ;; Capabilities
  ;; ---------------------------------------------------------------------------
  (defcap BACKFILL ()
    @doc "Held by the backfill keyset. A signer may scope its signature to this."
    (enforce-keyset BACKFILL-KS))

  (defcap ATTESTED (height:integer bhash:string btime:time by:string)
    @doc "Emitted once per attested block; the event stream is the tamper-evident log."
    @event true)

  (defcap BACKFILLED (height:integer bhash:string btime:time by:string)
    @event true)

  (defcap BACKFILL-CLOSED (at-height:integer by:string)
    @event true)

  ;; ---------------------------------------------------------------------------
  ;; Pure helpers
  ;; ---------------------------------------------------------------------------
  (defun key:string (height:integer)
    @doc "Row key for a height: fixed-width, zero-padded decimal."
    (enforce (and (>= height 0) (< height MAX-HEIGHT))
      "block-history: key: height out of range")
    (let ((s (int-to-str 10 height)))
      (+ (take (- KEY-WIDTH (length s)) ZEROS) s)))

  (defun valid-hash:bool (h:string)
    @doc "True when `h` has the exact shape of a chainweb block hash: 43 unpadded \
    \base64url characters. Shape only — the platform cannot verify the value."
    (and (= HASH-LENGTH (length h))
         (= HASH-LENGTH
            (length (filter (lambda (c:string) (contains c B64URL)) (str-to-list h))))))

  ;; ---------------------------------------------------------------------------
  ;; Writes
  ;; ---------------------------------------------------------------------------
  (defun attest:string ()
    @doc "Record the previous block. No arguments: the height, hash and time all come \
    \from (chain-data). Idempotent — a second call for an already-recorded height is a \
    \cheap no-op, never an abort, so any number of recorders may call it every block."
    (let* ((cd (chain-data))
           (n (at 'block-height cd))
           (h (- n 1))
           (bh (at 'prev-block-hash cd))
           (bt (at 'block-time cd))
           (by (at 'sender cd)))
      (enforce (> n 0) "block-history: attest: no previous block at genesis")
      (enforce (!= "" bh) "block-history: attest: engine supplied no previous block hash")
      (let ((k (key h)))
        (with-default-read attested k { "hash": "" } { "hash" := have }
          (if (!= have "")
              "already recorded"
              (let ((prev (at 'height (latest))))
                (insert attested k { "hash": bh, "time": bt, "by": by })
                (if (> h prev)
                    (write latest-tbl "latest" { "height": h, "hash": bh, "time": bt })
                    "latest unchanged")
                (emit-event (ATTESTED h bh bt by))
                "recorded"))))))

  (defun backfill:object (rows:[object{block-in}])
    @doc "Record older blocks under the backfill keyset, while the window is open. \
    \Every row must be strictly older than what `attest` can record now, carry a \
    \well-formed hash, and name a height that is not attested. A row already \
    \backfilled with the SAME hash is skipped (retries are safe); a different hash for \
    \an already-backfilled height aborts the whole batch. Returns {written, skipped}."
    (with-capability (BACKFILL)
      (let* ((cd (chain-data))
             (frontier (- (at 'block-height cd) 1))
             (by (at 'sender cd))
             (wnd (backfill-status)))
        (enforce (at 'open wnd) "block-history: backfill: the backfill window is closed")
        (enforce (> (length rows) 0) "block-history: backfill: no rows")
        (let ((results
               (map (lambda (r:object{block-in})
                      (let* ((h (at 'height r))
                             (bh (at 'hash r))
                             (bt (at 'time r))
                             (k (key h)))
                        (enforce (< h frontier)
                          "block-history: backfill: height is attestable, not backfillable")
                        (enforce (valid-hash bh) "block-history: backfill: malformed block hash")
                        (with-default-read attested k { "hash": "" } { "hash" := a }
                          (enforce (= a "") "block-history: backfill: height is already attested"))
                        (with-default-read backfilled k { "hash": "" } { "hash" := b }
                          (if (= b "")
                              (let ((unused 0))
                                (insert backfilled k { "hash": bh, "time": bt, "by": by })
                                (emit-event (BACKFILLED h bh bt by))
                                "written")
                              (let ((unused 0))
                                (enforce (= b bh)
                                  "block-history: backfill: conflicting hash for an already backfilled height")
                                "skipped")))))
                    rows)))
          { "written": (length (filter (lambda (s:string) (= s "written")) results))
          , "skipped": (length (filter (lambda (s:string) (= s "skipped")) results)) }))))

  (defun close-backfill:string ()
    @doc "Close the backfill window forever. There is no function that reopens it."
    (with-capability (BACKFILL)
      (let* ((wnd (backfill-status))
             (cd (chain-data))
             (n (at 'block-height cd))
             (by (at 'sender cd)))
        (enforce (at 'open wnd) "block-history: close-backfill: the backfill window is already closed")
        (write backfill-window "window" { "open": false, "closed-at": n })
        (emit-event (BACKFILL-CLOSED n by))
        "closed")))

  ;; ---------------------------------------------------------------------------
  ;; Reads. Point reads only; nothing here scans a table.
  ;; ---------------------------------------------------------------------------
  (defun get-attested:object{block} (height:integer)
    @doc "The engine-attested record of a height. Aborts if it was never attested. \
    \This is the read to settle money on."
    (read attested (key height)))

  (defun get-backfilled:object{block} (height:integer)
    @doc "The backfilled (trusted) record of a height. Aborts if there is none."
    (read backfilled (key height)))

  (defun get-block:object (height:integer)
    @doc "The record of a height from whichever table holds it, tagged with its \
    \`source` (\"attested\" or \"backfilled\"). Aborts if neither holds it."
    (let ((k (key height)))
      (with-default-read attested k
        { "hash": "", "time": EPOCH, "by": "" }
        { "hash" := ah, "time" := atm, "by" := ab }
        (if (!= ah "")
            { "height": height, "source": "attested", "hash": ah, "time": atm, "by": ab }
            (with-default-read backfilled k
              { "hash": "", "time": EPOCH, "by": "" }
              { "hash" := bh, "time" := bt, "by" := bb }
              (enforce (!= bh "") "block-history: get-block: no record for this height")
              { "height": height, "source": "backfilled", "hash": bh, "time": bt, "by": bb })))))

  (defun hash-of:string (height:integer)
    @doc "The attested hash of a height. Aborts if the height was not attested."
    (at 'hash (get-attested height)))

  (defun time-of:time (height:integer)
    @doc "The attested creation time of a height. Aborts if the height was not attested."
    (at 'time (get-attested height)))

  (defun has-attested:bool (height:integer)
    (with-default-read attested (key height) { "hash": "" } { "hash" := h } (!= h "")))

  (defun has-backfilled:bool (height:integer)
    (with-default-read backfilled (key height) { "hash": "" } { "hash" := h } (!= h "")))

  (defun has-block:bool (height:integer)
    @doc "True when either table holds the height. Use it to detect gaps."
    (or (has-attested height) (has-backfilled height)))

  (defun latest:object{latest-row} ()
    @doc "The highest attested block. Height -1 and an empty hash before the first one."
    (with-default-read latest-tbl "latest"
      { "height": -1, "hash": "", "time": EPOCH }
      { "height" := h, "hash" := bh, "time" := bt }
      { "height": h, "hash": bh, "time": bt }))

  (defun backfill-status:object{window} ()
    @doc "Whether backfill is still possible, and the height it was closed at (-1 if open)."
    (with-default-read backfill-window "window"
      { "open": true, "closed-at": -1 }
      { "open" := o, "closed-at" := c }
      { "open": o, "closed-at": c }))

  (defun chain:string ()
    @doc "The chain this instance records. Each chain has its own, independent instance."
    (at 'chain-id (chain-data)))
)

(create-table attested)
(create-table backfilled)
(create-table latest-tbl)
(create-table backfill-window)
