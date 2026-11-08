/* Firebase sign-in + Firestore access for Life Tracker.
 * app.js talks to this through the global `Account`; it never touches Firebase directly.
 * Passwords are handled by Firebase Authentication only — nothing password-related is stored in Firestore. */
'use strict';

const Account = (() => {
  let auth, db, onChange = () => {}, busy = false;

  const FRIENDLY = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'Wrong email or password.',
    'auth/invalid-email': 'That email address does not look right.',
    'auth/email-already-in-use': 'That email is already registered. Try signing in.',
    'auth/weak-password': 'Use a password of at least 8 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/requires-recent-login': 'Please sign in again, then retry.',
    'auth/network-request-failed': 'Network problem. Check your connection.',
    'permission-denied': 'You do not have permission to do that.'
  };
  const fail = e => { throw new Error(FRIENDLY[e.code] || e.message || 'Something went wrong.'); };
  const lower = s => String(s || '').trim().toLowerCase();

  async function profileOf(user) {
    const snap = await db.doc('members/' + user.uid).get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (d.deleted) return null;
    return { uid: user.uid, email: user.email, userName: d.userName, role: d.role || 'user', gender: d.gender || '' };
  }

  async function emit(user) {
    if (!user) return onChange(null);
    let profile = null;
    try { profile = await profileOf(user); } catch (e) { /* treated as not set up */ }
    if (!profile) {
      await auth.signOut();
      return onChange(null, 'This account is not set up. Ask the admin to invite your email, then register.');
    }
    onChange(profile);
  }

  return {
    configured: () => !!(window.APP_CONFIG?.firebase?.apiKey && window.APP_CONFIG?.firebase?.projectId),

    init(handler) {
      onChange = handler;
      firebase.initializeApp(window.APP_CONFIG.firebase);
      auth = firebase.auth();
      db = firebase.firestore();
      auth.onAuthStateChanged(user => { if (!busy) emit(user); });
    },

    token: async () => {
      if (!auth.currentUser) throw new Error('Please sign in.');
      return auth.currentUser.getIdToken();
    },

    async signIn(email, password) {
      try { await auth.signInWithEmailAndPassword(lower(email), password); } catch (e) { fail(e); }
    },

    /** Invite-only: the email must already be in /invites. Rolls the new login back if anything fails. */
    async register({ userName, email, password, gender }) {
      email = lower(email); userName = String(userName || '').trim();
      if (!['female', 'male', 'other'].includes(gender)) throw new Error('Please select a gender.');
      if (!/^[A-Za-z0-9_-]{3,30}$/.test(userName)) throw new Error('Username: 3–30 letters, numbers, _ or -, no spaces.');
      busy = true;
      let cred;
      try {
        try { cred = await auth.createUserWithEmailAndPassword(email, password); } catch (e) { fail(e); }
        try {
          const invite = await db.doc('invites/' + email).get();
          if (!invite.exists) throw new Error('This email has not been invited. Ask the admin to invite it first.');
          const taken = await db.doc('usernames/' + userName.toLowerCase()).get();
          if (taken.exists) throw new Error('That username is taken. Pick another.');
          const batch = db.batch();
          batch.set(db.doc('usernames/' + userName.toLowerCase()), { uid: cred.user.uid });
          batch.set(db.doc('members/' + cred.user.uid), {
            userName, email, gender, role: 'user', createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          await batch.commit();
        } catch (e) {
          await cred.user.delete().catch(() => {});
          throw e.code ? new Error(FRIENDLY[e.code] || e.message) : e;
        }
      } finally { busy = false; }
      await emit(auth.currentUser);
    },

    async resetPassword(email) {
      try { await auth.sendPasswordResetEmail(lower(email)); } catch (e) { fail(e); }
    },

    /** Firebase requires re-entering the current password before it will change it. */
    async changePassword(current, next) {
      const user = auth.currentUser;
      try {
        await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, current));
        await user.updatePassword(next);
      } catch (e) { fail(e); }
    },

    signOut: () => auth.signOut(),

    /** Deletes the signed-in person's login. Their member record stays, flagged deleted, so the admin can see it and remove the row. */
    async deleteAccount(password) {
      const user = auth.currentUser, ref = db.doc('members/' + user.uid);
      busy = true;   // the sign-out that follows must not be reported as "not set up"
      try {
        try { await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, password)); } catch (e) { fail(e); }
        await ref.update({ deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(fail);
        try { await user.delete(); } catch (e) {
          await ref.update({ deleted: false }).catch(() => {});   // not allowed by the rules; the admin can fix by hand
          fail(e);
        }
      } finally { busy = false; }
      onChange(null, 'Your account has been deleted.');
    },

    /** document_link rows for one user, oldest year first. */
    async listYears(uid) {
      try {
        const snap = await db.collection('document_link').where('userId', '==', uid).get();
        return snap.docs.map(d => d.data()).sort((a, b) => a.year - b.year);
      } catch (e) { fail(e); }
    },

    /** Unseen "an admin uploaded <year> for you" notices. Never throws: a notice is not worth blocking sign-in. */
    async listNotices(uid) {
      try {
        const snap = await db.collection('notices').where('userId', '==', uid).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.year - b.year);
      } catch (e) { console.warn('Could not read notices (are the Firestore rules published?)', e.code || e); return []; }
    },
    async clearNotices(ids) {
      try { await Promise.all(ids.map(id => db.doc(`notices/${id}`).delete())); } catch (e) { /* shown again next time */ }
    },

    /** Live feed of admin messages addressed to this email. onData gets the current list each time it changes.
     *  Returns an unsubscribe function. Never throws: a message is not worth blocking sign-in. */
    watchMessages(email, onData) {
      try {
        return db.collection('messages').where('email', '==', lower(email)).onSnapshot(
          snap => onData(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0))),
          e => { console.warn('Could not read messages (are the Firestore rules published?)', e.code || e); onData([]); });
      } catch (e) { onData([]); return () => {}; }
    },
    async deleteMessage(id) {
      try { await db.doc('messages/' + id).delete(); } catch (e) { /* shown again next time */ }
    },

    /* ----- admin ----- */
    /** Admin: send one message to each email. Throws if any write is refused. */
    async sendMessage(emails, text, icon, by, deliverAt) {
      try {
        const batch = db.batch();
        [...new Set(emails.map(lower))].forEach(email => batch.set(db.collection('messages').doc(), {
          email, text, icon, by, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          ...(deliverAt ? { deliverAt: firebase.firestore.Timestamp.fromDate(deliverAt) } : {}) }));
        await batch.commit();
      } catch (e) { fail(e); }
    },
    async listMembers() {
      try {
        const snap = await db.collection('members').get();
        return snap.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => a.userName.localeCompare(b.userName));
      } catch (e) { fail(e); }
    },
    async listInvites() {
      try { return (await db.collection('invites').get()).docs.map(d => d.data()); } catch (e) { fail(e); }
    },
    async addInvite(email) {
      email = lower(email);
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('That email address does not look right.');
      try {
        await db.doc('invites/' + email).set({ email, invitedAt: firebase.firestore.FieldValue.serverTimestamp() });
      } catch (e) { fail(e); }
    },
    async removeInvite(email) {
      try { await db.doc('invites/' + lower(email)).delete(); } catch (e) { fail(e); }
    },
    /** Admin: clears a deleted member's row, their year rows, username and invite (so they need a fresh invite). Drive files are left alone. */
    async removeMember(member, years) {
      try {
        await Promise.all(years.map(r => db.doc(`document_link/${member.uid}_${r.year}`).delete()));
        await db.doc('members/' + member.uid).delete();
        await db.doc('usernames/' + member.userName.toLowerCase()).delete();
        await db.doc('invites/' + lower(member.email)).delete();
      } catch (e) { fail(e); }
    },
    async removeLink(uid, year) {
      try { await db.doc(`document_link/${uid}_${year}`).delete(); } catch (e) { fail(e); }
    },

    /* ----- astrology pairs (astro_pairs): written by the admin, read by the admin and the two people in it ----- */
    /** The pair this person belongs to, or null. */
    async myAstroPair(uid) {
      const snap = await db.collection('astro_pairs').where('members', 'array-contains', uid).limit(1).get();
      return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    },
    async listAstroPairs() {
      try { return (await db.collection('astro_pairs').get()).docs.map(d => ({ id: d.id, ...d.data() })); } catch (e) { fail(e); }
    },
    /** Admin: create (id null) or replace a pair. */
    async saveAstroPair(id, data) {
      const now = firebase.firestore.FieldValue.serverTimestamp();
      try {
        if (id) await db.doc('astro_pairs/' + id).set({ ...data, updatedAt: now });
        else await db.collection('astro_pairs').add({ ...data, createdAt: now, updatedAt: now });
      } catch (e) { fail(e); }
    },
    async deleteAstroPair(id) {
      try { await db.doc('astro_pairs/' + id).delete(); } catch (e) { fail(e); }
    }
  };
})();
