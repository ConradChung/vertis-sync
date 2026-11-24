/** A refusal from the Maps lane (lib/maps), with the HTTP status a route answers with. */
export class MapsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'MapsError'
  }
}
