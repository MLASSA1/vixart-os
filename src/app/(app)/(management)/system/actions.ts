'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/auth';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
// Only the type. A `'use server'` module may export nothing but async
// functions — re-exporting EMPTY_STATE from here builds fine under tsc and
// fails at `next build` with "can only export async functions, found object".
// The form imports it from '@/lib/form-state' directly, which is the point of
// that module existing. See its own docstring, which says exactly this.
import { type FormState } from '@/lib/form-state';

/**
 * Where a client pays, saved by an administrator.
 *
 * No role check written here, and that is not an omission: `payment_detail_admin`
 * (0081) is the only policy on the table, so a moderator's session cannot see
 * the row at all and cannot update it. What IS checked below is how many rows
 * the UPDATE touched — under row level security a forbidden update is not an
 * error, it is zero rows, and reporting "Saved" to somebody who changed nothing
 * is the kind of lie that gets believed.
 */

/** Banks print these in groups. Strip what is decoration, keep what is data. */
function compact(value: string): string {
  return value.replace(/[\s .–—-]/g, '');
}

export async function savePaymentDetailAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireSession();

  const bankName = String(formData.get('bankName') ?? '').trim();
  const rib = compact(String(formData.get('rib') ?? ''));
  const iban = compact(String(formData.get('iban') ?? '')).toUpperCase();
  const swift = compact(String(formData.get('swift') ?? '')).toUpperCase();

  /*
   * Said in a sentence before the constraint says it in Postgres.
   *
   * The CHECKs in 0081 are the rule and they are not going anywhere — these
   * only exist so that a transposed digit comes back as "a RIB is 24 digits;
   * that is 23" rather than as a constraint name. A partial save is allowed on
   * purpose: the bank name may be known days before the IBAN arrives.
   */
  if (rib && !/^[0-9]{24}$/.test(rib)) {
    return {
      error: /[^0-9]/.test(rib)
        ? 'A RIB is digits only — 24 of them.'
        : `A Moroccan RIB is 24 digits; that one is ${rib.length}.`,
    };
  }
  if (iban && !/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(iban)) {
    return {
      error:
        'An IBAN starts with a two-letter country code and is 15 to 34 ' +
        "characters. Morocco's are 28, beginning MA.",
    };
  }
  if (swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift)) {
    return { error: `A SWIFT/BIC code is 8 or 11 characters; that one is ${swift.length}.` };
  }

  try {
    const touched = await withUser(async (tx, user) => {
      const result = await tx.execute(sql`
        UPDATE payment_detail
           SET bank_name     = ${bankName || null},
               rib           = ${rib || null},
               iban          = ${iban || null},
               swift         = ${swift || null},
               updated_at    = now(),
               updated_by_id = ${user.id}
      `);
      return result.rowCount ?? 0;
    });

    if (touched === 0) {
      return { error: 'Only an administrator can change where a client pays.' };
    }
  } catch (error) {
    return {
      error: describeDbError(error, {
        payment_detail_rib_shape: 'A Moroccan RIB is 24 digits.',
        payment_detail_iban_shape: 'That is not the shape of an IBAN.',
        payment_detail_swift_shape: 'A SWIFT/BIC code is 8 or 11 characters.',
        payment_detail_bank_name_present: 'Give the bank a name, or leave it empty.',
      }),
    };
  }

  revalidatePath('/system');
  /*
   * The second sentence is the whole point of snapshotting. Somebody changing
   * banks needs to know, at the moment they change it, that the invoices
   * already out there still say the old account — otherwise they will go
   * looking for why, or worse, assume they were rewritten.
   */
  return {
    error: null,
    notice:
      'Saved. Documents issued from now on carry these details; ' +
      'anything already issued keeps the account it was issued with.',
  };
}
