/**
 * manual_setWizardNotifySecret — siembra WIZARD_NOTIFY_SECRET en el wizard (CLI SEED-NOTIFY-PROPS).
 *
 * Push-half de la Opción A (notify KMS→wizard): el KMS hace doPost al /exec del wizard al cambiar
 * estado/milestone, gateado por un secreto compartido. Este valor DEBE ser EL MISMO que la Script
 * Property WIZARD_NOTIFY_SECRET del KMS. Sin él, el push-half es no-op (el cheap-poll del wizard
 * sigue funcionando vía live_version). NO se registra en el dispatcher público (helper de owner).
 *
 * @param {string} secret El mismo UUID sembrado en el KMS.
 * @returns {string} 'ok'
 */
function manual_setWizardNotifySecret(secret) {
  PropertiesService.getScriptProperties().setProperty('WIZARD_NOTIFY_SECRET', secret);
  Logger.log('Wizard notify secret set'); return 'ok';
}
