const defaultSpawnPosition = { x: 200, y: 200 };

createLevel = options => {
  log('createLevel: start', { options });

  check(options.templateId, Match.Maybe(Match.Id));
  check(options.name, Match.Maybe(Match.SafeString));
  check(options.guildId, Match.Maybe(Match.Id));
  check(options.createdBy, Match.Maybe(Match.Id));

  const { createdBy, name, templateId } = options;
  const now = new Date();
  const user = createdBy ? Meteor.users.findOne(createdBy) : Meteor.user();

  const newLevelId = Levels.id();
  const levelName = name || `${user.profile.name || user.username}'s world`;
  Levels.insert({
    _id: newLevelId,
    name: levelName,
    spawn: defaultSpawnPosition,
    apiKey: CryptoJS.MD5(now + Random.hexString(48)).toString(),
    createdAt: now,
    createdBy: user._id,
  });

  if (templateId) {
    log('createLevel: copy template', { templateId });
    const { metadata, spawn, width, height } = Levels.findOne(templateId);
    Levels.update(newLevelId, { $set: { template: false, metadata, spawn: spawn || defaultSpawnPosition, width, height, templateId } });

    const tiles = Tiles.find({ levelId: templateId }).fetch();
    tiles.forEach(tile => {
      Tiles.insert({
        ...tile,
        _id: Tiles.id(),
        createdAt: now,
        createdBy: user._id,
        levelId: newLevelId,
      });
    });

    const zones = Zones.find({ levelId: templateId }).fetch();
    zones.forEach(zone => {
      Zones.insert({
        ...zone,
        _id: Zones.id(),
        createdAt: now,
        createdBy: user._id,
        levelId: newLevelId,
      });
    });

    const entities = Entities.find({ levelId: templateId }).fetch();
    entities.forEach(entity => {
      Entities.insert({
        ...entity,
        _id: Entities.id(),
        createdAt: now,
        createdBy: user._id,
        levelId: newLevelId,
      });
    });
  } else {
    log('createLevel: create empty level');
    const { levelId } = user.profile;

    Zones.insert({
      _id: Zones.id(),
      adminOnly: false,
      createdAt: now,
      createdBy: user._id,
      levelId: newLevelId,
      targetedLevelId: levelId,
      name: 'Previous world',
      x1: 10,
      x2: 110,
      y1: 10,
      y2: 110,
    });
  }

  analytics.track(user._id, '🐣 Level Created', { level_id: newLevelId, level_name: levelName });
  log('createLevel: done', { levelId: newLevelId, levelName });

  return newLevelId;
};

deleteLevel = levelId => {
  log('deleteLevel: start', { levelId });

  const numLevels = Levels.find().count();
  if (numLevels === 1) {
    error('deleteLevel: can not delete last level');
    throw new Meteor.Error('not-allowed', 'Can not delete last level');
  }

  Entities.remove({ levelId });
  Zones.remove({ levelId });
  Tiles.remove({ levelId });
  Levels.remove({ _id: levelId });
  Meteor.users.update({ 'profile.levelId': levelId }, { $set: { 'profile.levelId': Meteor.settings.defaultLevelId } }, { multi: true });
};

Meteor.publish('levels', function () {
  if (!this.userId) return undefined;

  return Levels.find({ }, { fields: { name: 1, hide: 1, visit: 1, createdBy: 1, template: 1 } });
});

Meteor.publish('levelTemplates', function () {
  if (!this.userId) return undefined;

  return Levels.find({ template: true, hide: { $exists: false } }, { fields: { name: 1, hide: 1, visit: 1, createdBy: 1, template: 1 } });
});

Meteor.publish('currentLevel', function () {
  if (!this.userId) return undefined;

  const { name } = Meteor.user().profile;
  const { levelId } = Meteor.user().profile || Meteor.settings.defaultLevelId;
  callHooks(Levels.findOne(levelId), activityType.userEnteredLevel, { userId: this.userId, meta: { name } });

  this.onStop(() => callHooks(Levels.findOne(levelId), activityType.userLeavedLevel, { userId: this.userId, meta: { name } }));

  return Levels.find(
    { _id: levelId },
    { fields: { name: 1, spawn: 1, hide: 1, height: 1, width: 1, editorUserIds: 1, createdBy: 1, sandbox: 1, guildId: 1 } },
  );
});

Meteor.methods({
  toggleLevelEditionPermission(userId) {
    check(userId, Match.Id);
    if (!isEditionAllowed(this.userId)) return;

    const { levelId } = Meteor.user().profile;
    if (!isEditionAllowed(userId)) Levels.update(levelId, { $addToSet: { editorUserIds: { $each: [userId] } } });
    else Levels.update(levelId, { $pull: { editorUserIds: userId } });
  },
  createLevel(templateId = undefined) {
    if (!this.userId) throw new Meteor.Error('missing-user', 'A valid user is required');
    check(templateId, Match.Maybe(Match.Id));

    return createLevel({ templateId });
  },
  updateLevel(name, position, hide) {
    if (!this.userId) throw new Meteor.Error('missing-user', 'A valid user is required');
    check(name, String);
    check(position, { x: Number, y: Number });
    check(hide, Boolean);

    const level = userLevel(this.userId);
    if (!level || level.sandbox) throw new Meteor.Error('invalid-level', 'A valid level is required');
    if (!isEditionAllowed(this.userId)) throw new Meteor.Error('permission-error', `You can't edit this level`);

    const query = { $set: { name, spawn: { x: position.x, y: position.y } } };
    if (hide) query.$set.hide = true;
    else query.$unset = { hide: 1 };

    Levels.update(level._id, query);
  },
  increaseLevelVisits(levelId) {
    if (!this.userId) return;
    check(levelId, Match.Id);

    Levels.update({ _id: levelId, createdBy: { $ne: this.userId } }, { $inc: { visit: 1 } });
  },
});
