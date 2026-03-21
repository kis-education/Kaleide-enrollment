export default function HoneypotField() {
  return (
    <input
      type="text"
      name="_hp"
      className="hp-field"
      tabIndex="-1"
      autoComplete="off"
      aria-hidden="true"
      defaultValue=""
    />
  );
}
