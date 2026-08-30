/**
 * Helpers shared by the integration tests. Not imported by the application.
 *
 * The suite runs against the SAME database the app uses. That is deliberate —
 * it is the only way to test triggers, policies and roles as they actually
 * exist — but it has one sharp edge, and this file is the guard rail for it.
 */

import type { Client } from 'pg';

/**
 * Put the document counters back where the surviving documents say they
 * should be.
 *
 * Issuing a document takes a number from a row-locked counter, on purpose and
 * irreversibly: that is what makes the numbering gapless. A test that issues
 * an invoice and then deletes it therefore BURNS a real number, and the
 * counter never goes back down on its own.
 *
 * That is not hypothetical. It was found by auditing the live database: the
 * facture counter stood at 12 while not one invoice had ever been issued —
 * twelve numbers eaten by test runs. The first real invoice would have been
 * FAC-2026-0013, which on a Moroccan invoice reads as twelve missing ones.
 *
 * Recomputing from the documents that actually survive is self-correcting: if
 * a real invoice is issued, its number is the floor and nothing is lost; if
 * the probes cleaned up after themselves, the counter returns to where it was.
 * Call it from afterAll in any test that issues a document.
 */
export async function restoreDocumentCounters(db: Client): Promise<void> {
  await db.query(`
    UPDATE document_counter c
       SET last_seq = coalesce(
             (SELECT max(d.number_seq) FROM document d
               WHERE d.doc_type = c.doc_type AND d.number_year = c.year), 0)
  `);
}
