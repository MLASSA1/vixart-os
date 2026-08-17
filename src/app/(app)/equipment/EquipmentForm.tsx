'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextArea, TextInput } from '@/components/ui';
import { EQUIPMENT_CATEGORIES } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Adding…' : 'Add to register'}
    </button>
  );
}

export function EquipmentForm({
  action,
  canSeeCost,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  canSeeCost: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="border border-void/25 p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput name="name" label="What is it" required placeholder="Sony FX3" />
        <Select
          name="category"
          label="Category"
          required
          defaultValue="camera"
          options={EQUIPMENT_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
        />
        <TextInput name="brand" label="Brand" placeholder="Sony" />
        <TextInput name="model" label="Model" placeholder="ILME-FX3" />
        <TextInput
          name="serialNumber"
          label="Serial number"
          hint="Worth filling in — it is what an insurer asks for."
        />
        <TextInput name="purchaseDate" label="Bought on" type="date" />
        {canSeeCost && (
          <TextInput
            name="purchaseCost"
            label="Purchase cost (DH)"
            placeholder="0"
            hint="Reference only. Record the actual spend in Finance."
          />
        )}
        <TextArea name="notes" label="Notes" rows={2} fullWidth />
      </FormGrid>
      <div className="mt-5">
        <Submit />
      </div>
    </form>
  );
}
