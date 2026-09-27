'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, NoticeBanner } from '@/components/ui';
import { EMPTY_STATE } from '@/lib/form-state';
import { formatBytes, MAX_UPLOAD_BYTES } from '@/lib/upload-types';
import { saveMyProfileAction } from './actions';

const MAX_BIO = 600;

function Save() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : 'Save my profile'}
    </button>
  );
}

/**
 * What a person says about themselves.
 *
 * Amin asked for four things: change your name, set a picture, add a banner,
 * write a description. One form, because they are one act — nobody sits down to
 * "change their banner" as a separate errand.
 *
 * The pictures are shown as they will appear rather than as file inputs, because
 * "did that upload work" is the only question anybody has here and a grey "No
 * file chosen" does not answer it.
 */
export function ProfileForm({
  fullName,
  bio,
  hasAvatar,
  hasBanner,
  personId,
}: {
  fullName: string;
  bio: string | null;
  hasAvatar: boolean;
  hasBanner: boolean;
  personId: string;
}) {
  const [state, formAction] = useActionState(saveMyProfileAction, EMPTY_STATE);

  const [chosenAvatar, setChosenAvatar] = useState<string | null>(null);
  const [chosenBanner, setChosenBanner] = useState<string | null>(null);
  const [dropAvatar, setDropAvatar] = useState(false);
  const [dropBanner, setDropBanner] = useState(false);
  const [count, setCount] = useState((bio ?? '').length);

  /*
   * A cache-buster on the existing image.
   *
   * The avatar route answers with a five-minute cache, which is right for the
   * hundred places a face is drawn and wrong for exactly one: the screen where
   * you have just changed it. Without this you replace your picture, the page
   * reloads, and the old one is still there — which reads as the save having
   * failed.
   */
  const [version] = useState(() => Date.now());
  const avatarSrc = `/api/avatar/${personId}?v=${version}`;
  const bannerSrc = `/api/avatar/${personId}?banner=1&v=${version}`;

  return (
    <form action={formAction}>
      <ErrorBanner message={state.error} />
      <NoticeBanner message={state.notice} />

      {/* --- the banner, at the top, because that is where it appears ------- */}
      <label className="block">
        <span className="label block">Banner</span>
        <span className="mt-0.5 block text-[15px]" style={{ opacity: 0.52 }}>
          The strip across the top of your profile. Wide and short — roughly
          three to one.
        </span>

        <span
          className="mt-3 block h-28 w-full max-w-xl overflow-hidden rounded-[12px] bg-void/[0.06]"
        >
          {chosenBanner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={chosenBanner} alt="" className="h-full w-full object-cover" />
          ) : hasBanner && !dropBanner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bannerSrc} alt="" className="h-full w-full object-cover" />
          ) : null}
        </span>

        <input
          type="file"
          name="banner"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="mt-2 block text-[13.5px]"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            setChosenBanner(f ? URL.createObjectURL(f) : null);
            if (f) setDropBanner(false);
          }}
        />
      </label>
      {hasBanner && (
        <label className="mt-2 flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            name="bannerRemove"
            value="1"
            checked={dropBanner}
            onChange={(e) => setDropBanner(e.currentTarget.checked)}
            className="h-4 w-4 accent-[#6D28D9]"
          />
          Remove my banner
        </label>
      )}

      {/* --- the picture ---------------------------------------------------- */}
      <label className="mt-9 block">
        <span className="label block">Picture</span>
        <span className="mt-0.5 block text-[15px]" style={{ opacity: 0.52 }}>
          Shown beside everything you write. Square works best.
        </span>

        <span className="mt-3 flex items-center gap-4">
          <span className="block h-20 w-20 shrink-0 overflow-hidden rounded-[14px] bg-void/[0.06]">
            {chosenAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={chosenAvatar} alt="" className="h-full w-full object-cover" />
            ) : hasAvatar && !dropAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <input
            type="file"
            name="avatar"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="block text-[13.5px]"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              setChosenAvatar(f ? URL.createObjectURL(f) : null);
              if (f) setDropAvatar(false);
            }}
          />
        </span>
      </label>
      {hasAvatar && (
        <label className="mt-2 flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            name="avatarRemove"
            value="1"
            checked={dropAvatar}
            onChange={(e) => setDropAvatar(e.currentTarget.checked)}
            className="h-4 w-4 accent-[#6D28D9]"
          />
          Remove my picture
        </label>
      )}

      <p className="mt-2 text-[13px]" style={{ opacity: 0.52 }}>
        JPEG, PNG, WebP or GIF, up to {formatBytes(MAX_UPLOAD_BYTES)}. An iPhone
        set to “High Efficiency” produces HEIC, which most browsers cannot show —
        switch Camera → Formats to “Most Compatible”.
      </p>

      {/* --- the words ------------------------------------------------------ */}
      <label className="mt-9 block" htmlFor="fullName">
        <span className="label block">Name</span>
        <input
          id="fullName"
          name="fullName"
          required
          maxLength={120}
          defaultValue={fullName}
          className="input mt-2"
        />
      </label>

      <label className="mt-6 block" htmlFor="bio">
        <span className="label block">About you</span>
        <span className="mt-0.5 block text-[15px]" style={{ opacity: 0.52 }}>
          What you do here, what to come to you for. Your colleagues see this on
          your profile.
        </span>
        <textarea
          id="bio"
          name="bio"
          rows={4}
          maxLength={MAX_BIO}
          defaultValue={bio ?? ''}
          onChange={(e) => setCount(e.currentTarget.value.length)}
          className="input mt-2 resize-y"
        />
        <span className="mt-1 block text-right text-[12.5px] tabular-nums" style={{ opacity: 0.5 }}>
          {count} / {MAX_BIO}
        </span>
      </label>

      <div className="mt-7">
        <Save />
      </div>
    </form>
  );
}
