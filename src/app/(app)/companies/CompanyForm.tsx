'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  Checkbox,
  ErrorBanner,
  FormGrid,
  Select,
  TextArea,
  TextInput,
} from '@/components/ui';
import type { Company } from '@/db/schema';
import { COMPANY_STAGES, RELATIONSHIPS } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function CompanyForm({
  action,
  record,
  submitLabel,
  cancelHref,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  record?: Company;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <form action={formAction}>
      <ErrorBanner message={state.error} />

      <fieldset className="mb-10">
        <legend className="label mb-4 w-full border-b border-void pb-2">Identity</legend>
        <FormGrid>
          <TextInput
            name="name"
            label="Trading name"
            required
            defaultValue={record?.name}
            hint="The name the team uses day to day."
          />
          <TextInput
            name="legalName"
            label="Registered name"
            defaultValue={record?.legalName}
            hint="Only if it differs from the trading name."
          />
          <Select
            name="relationship"
            label="Relationship"
            required
            defaultValue={record?.relationship ?? 'client'}
            options={RELATIONSHIPS.map((r) => ({ value: r.value, label: r.label }))}
            hint="What this organisation is to VIXART."
          />
          <Select
            name="status"
            label="Pipeline stage"
            required
            defaultValue={record?.status ?? 'lead'}
            options={COMPANY_STAGES.map((s) => ({ value: s.value, label: s.label }))}
            hint="Where they are in the pipeline."
          />
          <TextInput name="city" label="City" defaultValue={record?.city} />
          <TextInput
            name="addressLine"
            label="Address"
            defaultValue={record?.addressLine}
            fullWidth
          />
          <TextInput
            name="website"
            label="Website"
            type="url"
            placeholder="https://"
            defaultValue={record?.website}
            fullWidth
          />
        </FormGrid>
      </fieldset>

      <fieldset className="mb-10">
        <legend className="label mb-4 w-full border-b border-void pb-2">
          Legal identifiers
        </legend>
        <p className="prose-vixart mb-4 text-[15px]" style={{ opacity: 0.52 }}>
          Copy these from the client&apos;s own documents. They are printed on every
          quote and invoice — a wrong ICE makes the invoice wrong. Leave blank
          until you have the real value.
        </p>
        <FormGrid>
          <TextInput
            name="ice"
            label="ICE"
            defaultValue={record?.ice}
            pattern="[0-9]{15}"
            hint="Exactly 15 digits."
          />
          <TextInput
            name="identifiantFiscal"
            label="Tax ID (IF)"
            defaultValue={record?.identifiantFiscal}
            pattern="[0-9]{6,9}"
            hint="6 to 9 digits."
          />
          <TextInput
            name="registreCommerce"
            label="Trade register (RC)"
            defaultValue={record?.registreCommerce}
            fullWidth
          />
          <Checkbox
            name="retenueSource"
            label="Withholds VAT at source"
            checked={record?.retenueSource ?? false}
            hint="Article 117 bis CGI. When on, invoices for this client show both the total including VAT and the net to collect."
          />
        </FormGrid>
      </fieldset>

      <fieldset className="mb-10">
        <legend className="label mb-4 w-full border-b border-void pb-2">Engagement</legend>
        <FormGrid>
          <TextArea
            name="engagementSummary"
            label="Current engagement"
            rows={3}
            defaultValue={record?.engagementSummary}
            fullWidth
            hint="One or two lines. Shown in the pipeline list."
          />
          <TextArea
            name="notes"
            label="Internal notes"
            rows={5}
            defaultValue={record?.notes}
            fullWidth
          />
        </FormGrid>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-void pt-6">
        <SubmitButton label={submitLabel} />
        <Link href={cancelHref} className="btn btn-inverse">
          Cancel
        </Link>
      </div>
    </form>
  );
}
