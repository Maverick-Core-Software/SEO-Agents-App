export function ReadOnlyButton({
  children,
  title = 'write action — read-only slice',
  className,
  onClick: _onClick,
  ...rest
}) {
  return (
    <button
      type="button"
      disabled
      title={title}
      aria-disabled="true"
      data-readonly="true"
      className={['readonlyBtn', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
