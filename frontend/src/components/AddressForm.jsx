import { useTranslation } from 'react-i18next';
import { COUNTRIES } from '../constants/countries';

export const emptyAddress = () => ({
  address_line_1: '',
  address_line_2: '',
  city:           '',
  province:       '',
  country_id:     '',
  zip:            '',
});

/**
 * Reusable address form that maps to the enrAddresses table fields.
 * @param {Object}   address   - Address object with all enrAddresses fields
 * @param {Function} onChange  - Called with updated address object
 * @param {boolean}  disabled  - When true, all fields are read-only
 */
export default function AddressForm({ address, onChange, disabled = false }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...address, [f]: v });

  return (
    <div className="row g-3">
      <div className="col-12">
        <label className="form-label">{t('field.address_line_1')}</label>
        <input
          className="form-control"
          value={address.address_line_1}
          disabled={disabled}
          onChange={e => u('address_line_1', e.target.value)}
        />
      </div>
      <div className="col-12">
        <label className="form-label">{t('field.address_line_2')}</label>
        <input
          className="form-control"
          value={address.address_line_2}
          disabled={disabled}
          onChange={e => u('address_line_2', e.target.value)}
        />
      </div>
      <div className="col-md-4">
        <label className="form-label">{t('field.city')}</label>
        <input
          className="form-control"
          value={address.city}
          disabled={disabled}
          onChange={e => u('city', e.target.value)}
        />
      </div>
      <div className="col-md-3">
        <label className="form-label">{t('field.province')}</label>
        <input
          className="form-control"
          value={address.province}
          disabled={disabled}
          onChange={e => u('province', e.target.value)}
        />
      </div>
      <div className="col-md-3">
        <label className="form-label">{t('field.country')}</label>
        <select
          className="form-select"
          value={address.country_id}
          disabled={disabled}
          onChange={e => u('country_id', e.target.value)}
        >
          <option value="">{t('placeholder.select')}</option>
          {COUNTRIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div className="col-md-2">
        <label className="form-label">{t('field.zip')}</label>
        <input
          className="form-control"
          value={address.zip}
          disabled={disabled}
          onChange={e => u('zip', e.target.value)}
        />
      </div>
    </div>
  );
}
