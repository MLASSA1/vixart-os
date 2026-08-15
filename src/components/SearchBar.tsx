/**
 * Plain GET form. No client JavaScript: the query lives in the URL, so a search
 * can be bookmarked and the back button behaves.
 */
export function SearchBar({
  action,
  defaultValue,
  placeholder,
}: {
  action: string;
  defaultValue?: string;
  placeholder: string;
}) {
  return (
    <form action={action} className="flex items-center gap-2">
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
        className="input mt-0 max-w-xs"
      />
      <button type="submit" className="btn btn-inverse">
        Search
      </button>
    </form>
  );
}
