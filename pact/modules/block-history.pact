;; block-history.pact — an append-only, engine-attested record of this chain's blocks.
;;
;; WHY IT EXISTS. Inside Pact, (chain-data) is the only window onto the chain, and it
;; describes the PREVIOUS block: in the block at height N, `prev-block-hash` is the hash
;; of block N-1 and `block-time` is block N-1's creation time. So a transaction mined in
;; block N can write down a complete record of block N-1 using values it was handed by
;; the engine: no transaction chose them, and none can forge them. One block later that
;; window is gone for good. This module is the writing down.
;;
;; ONE WRITER, NO ARGUMENTS. Every row is written by `attest`, which takes no arguments:
;; key and value both come from (chain-data), so a caller decides only WHETHER a row is
;; written, never what it says. Rows are unforgeable and fork-consistent: a recording
;; transaction lives on the same fork as the block it records, so a contract always reads
;; its own fork's history. An off-chain reader at the tip has no such guarantee: it can
;; see a row that a reorg later replaces, so it should wait for confirmations before it
;; acts on one.
;;
;; ONLY WHAT WAS WITNESSED. A block is recorded only if a transaction in the very next
;; block called `attest`. Blocks from before the first `attest`, and blocks no recorder
;; attested, are simply absent: `has-attested` is false for them and every other read of
;; them aborts. Nothing in this module can add them later.
;;
;; IMMUTABLE FROM ITS FIRST DEPLOY. GOVERNANCE can never be satisfied, so no later code
;; can rewrite, reinterpret or delete a row. Pact has no row delete, so every row is
;; permanent by nature; this module makes the code as permanent as the data.
;;
;; WHAT TO SETTLE ON. `hash` is a consensus commitment the miner cannot forge. `time` is
;; the creation time the block's miner stamped, so it can drift by a few seconds — treat
;; it as metadata and express deadlines as heights.
;;
;; NOT A RANDOMNESS SOURCE, not even for a consumer that commits to a height in advance.
;; The miner of block H can withhold block H, and the miner of block H+1 alone decides
;; whether H is recorded at all, because only a transaction in H+1 can record it. So a
;; consumer that settles anything on a height must make an absent height neutral for
;; every party.
;;
;; ALL OF THIS ASSUMES A CLEAN DEPLOY. The transaction that deploys this module can also
;; write its tables, and the module hash cannot show it. A copy whose deploy transaction
;; did so is not this record, whatever its hash: check the deploy transaction itself.

(namespace (read-msg 'ns))

(module block-history GOVERNANCE
  ;; SPDX-License-Identifier: Apache-2.0

  @doc "Append-only record of this chain's blocks: height -> {hash, time, by}. \
  \`attest` takes no arguments and records the previous block. Its height, hash and \
  \time are engine values and can never be wrong; `by` is the recording transaction's \
  \gas payer, chosen by whoever submits it, and is informational only. Blocks before \
  \the first attest, and blocks no recorder attested, are simply absent. The module \
  \cannot be upgraded."

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
  ;; Row keys are zero-padded to 12 digits so an external key listing sorts numerically;
  ;; MAX-HEIGHT is the first height that no longer fits.
  (defconst KEY-WIDTH 12)
  (defconst ZEROS "000000000000")
  (defconst MAX-HEIGHT 1000000000000)
  ;; The time `latest` reports before anything is recorded.
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

  (defschema latest-row
    @doc "The highest attested block."
    height:integer
    hash:string
    time:time)

  (deftable attested:{block})
  (deftable latest-tbl:{latest-row})

  ;; ---------------------------------------------------------------------------
  ;; Events
  ;; ---------------------------------------------------------------------------
  (defcap ATTESTED (height:integer bhash:string btime:time by:string)
    @doc "Emitted once per attested block. A notification, not the record: the row is \
    \the record, so a reader should confirm an event with `get-attested`."
    @event true)

  ;; ---------------------------------------------------------------------------
  ;; Pure helper
  ;; ---------------------------------------------------------------------------
  (defun key:string (height:integer)
    @doc "Row key for a height: fixed-width, zero-padded decimal."
    (enforce (and (>= height 0) (< height MAX-HEIGHT))
      "block-history: key: height out of range")
    (let ((s (int-to-str 10 height)))
      (+ (take (- KEY-WIDTH (length s)) ZEROS) s)))

  ;; ---------------------------------------------------------------------------
  ;; The only write
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
              ;; On one fork every new record is above all earlier ones, so it is the
              ;; latest: written unconditionally, nothing left there before survives it.
              (do
                (insert attested k { "hash": bh, "time": bt, "by": by })
                (write latest-tbl "latest" { "height": h, "hash": bh, "time": bt })
                (emit-event (ATTESTED h bh bt by))
                "recorded"))))))

  ;; ---------------------------------------------------------------------------
  ;; Reads. Point reads only; nothing here scans a table.
  ;; ---------------------------------------------------------------------------
  (defun get-attested:object{block} (height:integer)
    @doc "The record of a height. Aborts if the height was never attested."
    (read attested (key height)))

  (defun hash-of:string (height:integer)
    @doc "The attested hash of a height. Aborts if the height was never attested."
    (at 'hash (get-attested height)))

  (defun time-of:time (height:integer)
    @doc "The attested creation time of a height. Aborts if the height was never attested."
    (at 'time (get-attested height)))

  (defun has-attested:bool (height:integer)
    @doc "True when the height was attested. Never aborts for a height in range: \
    \use it to find the gaps."
    (with-default-read attested (key height) { "hash": "" } { "hash" := h } (!= h "")))

  (defun latest:object{latest-row} ()
    @doc "The highest attested block. Height -1 and an empty hash before the first one."
    (with-default-read latest-tbl "latest"
      { "height": -1, "hash": "", "time": EPOCH }
      { "height" := h, "hash" := bh, "time" := bt }
      { "height": h, "hash": bh, "time": bt }))

  (defun chain:string ()
    @doc "The chain this instance records. Each chain has its own, independent instance."
    (at 'chain-id (chain-data)))
)

(create-table attested)
(create-table latest-tbl)
