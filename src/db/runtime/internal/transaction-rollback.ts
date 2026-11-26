/** @package */
export class TransactionRollback extends Error {
  constructor(readonly result: unknown) {
    super();
  }
}
