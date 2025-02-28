/**
 * @module SecretCreateOrUpdate
 * SecretCreateOrUpdate component displays either the form for creating a new secret or creating a new version of the secret
 *
 * @example
 * ```js
 * <SecretCreateOrUpdate
 *  @mode="create"
 *  @model={{model}}
 *  @showAdvancedMode=true
 *  @modelForData={{@modelForData}}
 *  @isV2=true
 *  @secretData={{@secretData}}
 *  @canCreateSecretMetadata=true
 * />
 * ```
 * @param {string} mode - create, edit, show determines what view to display
 * @param {object} model - the route model, comes from secret-v2 ember record
 * @param {boolean} showAdvancedMode - whether or not to show the JSON editor
 * @param {object} modelForData - a class that helps track secret data, defined in secret-edit
 * @param {boolean} isV2 - whether or not KV1 or KV2
 * @param {object} secretData - class that is created in secret-edit
 * @param {boolean} canCreateSecretMetadata - based on permissions to the /metadata/ endpoint. If user has secret create access.
 */

import Component from '@glimmer/component';
import ControlGroupError from 'vault/lib/control-group-error';
import Ember from 'ember';
import keys from 'vault/lib/keycodes';

import { action } from '@ember/object';
import { inject as service } from '@ember/service';
import { set } from '@ember/object';
import { tracked } from '@glimmer/tracking';

import { isBlank, isNone } from '@ember/utils';
import { task, waitForEvent } from 'ember-concurrency';

const LIST_ROUTE = 'vault.cluster.secrets.backend.list';
const LIST_ROOT_ROUTE = 'vault.cluster.secrets.backend.list-root';
const SHOW_ROUTE = 'vault.cluster.secrets.backend.show';

export default class SecretCreateOrUpdate extends Component {
  @tracked codemirrorString = null;
  @tracked error = null;
  @tracked secretPaths = null;
  @tracked validationErrorCount = 0;
  @tracked validationMessages = null;

  @service controlGroup;
  @service router;
  @service store;
  @service wizard;

  constructor() {
    super(...arguments);
    this.codemirrorString = this.args.secretData.toJSONString();
    this.validationMessages = {
      path: '',
    };
    // for validation, return array of path names already assigned
    if (Ember.testing) {
      this.secretPaths = ['beep', 'bop', 'boop'];
    } else {
      let adapter = this.store.adapterFor('secret-v2');
      let type = { modelName: 'secret-v2' };
      let query = { backend: this.args.model.backend };
      adapter.query(this.store, type, query).then(result => {
        this.secretPaths = result.data.keys;
      });
    }
    this.checkRows();

    if (this.args.mode === 'edit') {
      this.addRow();
    }
  }
  checkRows() {
    if (this.args.secretData.length === 0) {
      this.addRow();
    }
  }
  checkValidation(name, value) {
    if (name === 'path') {
      !value
        ? set(this.validationMessages, name, `${name} can't be blank.`)
        : set(this.validationMessages, name, '');
    }
    // check duplicate on path
    if (name === 'path' && value) {
      this.secretPaths?.includes(value)
        ? set(this.validationMessages, name, `A secret with this ${name} already exists.`)
        : set(this.validationMessages, name, '');
    }
    let values = Object.values(this.validationMessages);
    this.validationErrorCount = values.filter(Boolean).length;
  }
  onEscape(e) {
    if (e.keyCode !== keys.ESC || this.args.mode !== 'show') {
      return;
    }
    const parentKey = this.args.model.parentKey;
    if (parentKey) {
      this.transitionToRoute(LIST_ROUTE, parentKey);
    } else {
      this.transitionToRoute(LIST_ROOT_ROUTE);
    }
  }
  // successCallback is called in the context of the component
  persistKey(successCallback) {
    let secret = this.args.model;
    let secretData = this.args.modelForData;
    let isV2 = this.args.isV2;
    let key = secretData.get('path') || secret.id;

    if (key.startsWith('/')) {
      key = key.replace(/^\/+/g, '');
      secretData.set(secretData.pathAttr, key);
    }

    return secretData
      .save()
      .then(() => {
        if (!secretData.isError) {
          if (isV2) {
            secret.set('id', key);
          }
          if (isV2 && Object.keys(secret.changedAttributes()).length > 0) {
            // save secret metadata
            secret
              .save()
              .then(() => {
                this.saveComplete(successCallback, key);
              })
              .catch(e => {
                // when mode is not create the metadata error is handled in secret-edit-metadata
                if (this.mode === 'create') {
                  this.error = e.errors.join(' ');
                }
                return;
              });
          } else {
            this.saveComplete(successCallback, key);
          }
        }
      })
      .catch(error => {
        if (error instanceof ControlGroupError) {
          let errorMessage = this.controlGroup.logFromError(error);
          this.error = errorMessage.content;
        }
        throw error;
      });
  }
  saveComplete(callback, key) {
    if (this.wizard.featureState === 'secret') {
      this.wizard.transitionFeatureMachine('secret', 'CONTINUE');
    }
    callback(key);
  }
  transitionToRoute() {
    return this.router.transitionTo(...arguments);
  }

  get isCreateNewVersionFromOldVersion() {
    let model = this.args.model;
    if (!model) {
      return false;
    }
    if (
      !model.failedServerRead &&
      !model.selectedVersion?.failedServerRead &&
      model.selectedVersion?.version !== model.currentVersion
    ) {
      return true;
    }
    return false;
  }

  @(task(function*(name, value) {
    this.checkValidation(name, value);
    while (true) {
      let event = yield waitForEvent(document.body, 'keyup');
      this.onEscape(event);
    }
  })
    .on('didInsertElement')
    .cancelOn('willDestroyElement'))
  waitForKeyUp;

  @action
  addRow() {
    const data = this.args.secretData;
    // fired off on init
    if (isNone(data.findBy('name', ''))) {
      data.pushObject({ name: '', value: '' });
      this.handleChange();
    }
    this.checkRows();
  }
  @action
  codemirrorUpdated(val, codemirror) {
    this.error = null;
    codemirror.performLint();
    const noErrors = codemirror.state.lint.marked.length === 0;
    if (noErrors) {
      try {
        this.args.secretData.fromJSONString(val);
        set(this.args.modelForData, 'secretData', this.args.secretData.toJSON());
      } catch (e) {
        this.error = e.message;
      }
    }
    this.codemirrorString = val;
  }
  @action
  createOrUpdateKey(type, event) {
    event.preventDefault();
    if (type === 'create' && isBlank(this.args.modelForData.path || this.args.modelForData.id)) {
      this.checkValidation('path', '');
      return;
    }

    this.persistKey(() => {
      this.transitionToRoute(SHOW_ROUTE, this.args.model.path || this.args.model.id);
    });
  }
  @action
  deleteRow(name) {
    const data = this.args.secretData;
    const item = data.findBy('name', name);
    if (isBlank(item.name)) {
      return;
    }
    data.removeObject(item);
    this.checkRows();
    this.handleChange();
  }
  @action
  formatJSON() {
    this.codemirrorString = this.args.secretData.toJSONString(true);
  }
  @action
  handleChange() {
    this.codemirrorString = this.args.secretData.toJSONString(true);
    set(this.args.modelForData, 'secretData', this.args.secretData.toJSON());
  }
  //submit on shift + enter
  @action
  handleKeyDown(e) {
    e.stopPropagation();
    if (!(e.keyCode === keys.ENTER && e.metaKey)) {
      return;
    }
    let $form = this.element.querySelector('form');
    if ($form.length) {
      $form.submit();
    }
  }
  @action
  updateValidationErrorCount(errorCount) {
    this.validationErrorCount = errorCount;
  }
}
