import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { apiFetch } from '../lib/apiClient';
import { resolveUnifiedCapabilities, type UnifiedCapabilities } from '../lib/permissions';
import {
  BLUEPRINT_LIMITS,
  codeToInternalAuthId,
  formatPlayerCode,
  normalizePlayerCode,
  type AdminGrant,
  type PublicProfile,
  type SystemSettings,
  type UserPrivate,
} from '../types/nxf';

interface RegisterWithCodeInput {
  fullName: string;
  nick: string;
  code: string;
  password: string;
}

interface SignInResult {
  user: User;
  isOfficialMember: boolean;
}

interface AuthContextValue {
  firebaseUser: User | null;
  authReady: boolean;
  profileDocsReady: boolean;
  userDoc: UserPrivate | null;
  adminGrant: AdminGrant | null;
  publicProfile: PublicProfile | null;
  systemSettings: SystemSettings | null;
  capabilities: UnifiedCapabilities;
  unreadNotifications: number;
  signInWithCode: (code: string, password: string) => Promise<SignInResult>;
  signInWithProfile: (uid: string, password: string) => Promise<SignInResult>;
  registerWithCode: (input: RegisterWithCodeInput) => Promise<User>;
  reauthenticateRecent: (password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshClaims: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profileDocsReady, setProfileDocsReady] = useState(false);
  const [userDoc, setUserDoc] = useState<UserPrivate | null>(null);
  const [adminGrant, setAdminGrant] = useState<AdminGrant | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicProfile | null>(null);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [tokenClaims, setTokenClaims] = useState<{ primaryAdmin?: boolean; cms?: boolean }>({});
  const [unreadNotifications] = useState(0);
  const pendingRegistrationRef = useRef<{
    email: string;
    fullName: string;
    nick: string;
    code: string;
  } | null>(null);

  const ensureBasicUserDocument = async (
    user: User,
    registrationData?: { fullName: string; nick: string; code: string }
  ) => {
    const resolvedReg =
      registrationData ||
      (pendingRegistrationRef.current && pendingRegistrationRef.current.email === user.email
        ? pendingRegistrationRef.current
        : undefined);
    const userRef = doc(db, 'users', user.uid);
    try {
      const snap = await getDoc(userRef);
      if (!snap.exists()) {
        const cleanNick = (resolvedReg?.nick || user.displayName || 'Visitante')
          .trim()
          .slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
        const cleanFullName = (resolvedReg?.fullName || cleanNick)
          .trim()
          .slice(0, BLUEPRINT_LIMITS.FULL_NAME_MAX);
        const formattedCode = formatPlayerCode(
          resolvedReg?.code || user.uid.slice(0, 8)
        );

        await setDoc(userRef, {
          uid: user.uid,
          fullName: cleanFullName.length >= 2 ? cleanFullName : 'Visitante NXF',
          displayName: cleanNick.length >= 2 ? cleanNick : 'Visitante',
          code: formattedCode || `#${user.uid.slice(0, 6).toUpperCase()}`,
          roles: ['candidate'],
          delegatedPermissions: [],
          teamIds: [],
          status: 'active',
          brawlTag: formattedCode,
          brawlTagStatus: formattedCode ? 'pending' : 'none',
          authProviders: ['code_password'],
          hasLocalPassword: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
    }
  };

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setUserDoc(null);
        setAdminGrant(null);
        setPublicProfile(null);
        setSystemSettings(null);
        setTokenClaims({});
        setProfileDocsReady(true);
        setAuthReady(true);
        return;
      }

      setProfileDocsReady(false);
      try {
        const tokenRes = await user.getIdTokenResult();
        setTokenClaims({
          primaryAdmin: tokenRes.claims.primaryAdmin === true,
          cms: tokenRes.claims.cms === true,
        });
      } catch {
        setTokenClaims({});
      }

      await ensureBasicUserDocument(user);
      setAuthReady(true);
    });

    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!authReady || !firebaseUser) return;

    const uid = firebaseUser.uid;
    let userLoaded = false;
    let adminLoaded = false;

    const markReadyIfBothLoaded = () => {
      if (userLoaded && adminLoaded) {
        setProfileDocsReady(true);
      }
    };

    const unsubUser = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        setUserDoc(snap.exists() ? (snap.data() as UserPrivate) : null);
        userLoaded = true;
        markReadyIfBothLoaded();
      },
      (error) => {
        userLoaded = true;
        markReadyIfBothLoaded();
        handleFirestoreError(error, OperationType.GET, `users/${uid}`);
      }
    );

    const unsubProfile = onSnapshot(
      doc(db, 'publicProfiles', uid),
      (snap) => {
        setPublicProfile(snap.exists() ? (snap.data() as PublicProfile) : null);
      },
      () => {
        setPublicProfile(null);
      }
    );

    const unsubAdmin = onSnapshot(
      doc(db, 'admins', uid),
      (snap) => {
        setAdminGrant(snap.exists() ? (snap.data() as AdminGrant) : null);
        adminLoaded = true;
        markReadyIfBothLoaded();
      },
      () => {
        setAdminGrant(null);
        adminLoaded = true;
        markReadyIfBothLoaded();
      }
    );

    return () => {
      unsubUser();
      unsubProfile();
      unsubAdmin();
    };
  }, [authReady, firebaseUser]);

  const capabilities = useMemo(
    () => resolveUnifiedCapabilities(userDoc, adminGrant, tokenClaims),
    [userDoc, adminGrant, tokenClaims]
  );

  // Assinatura de systemSettings restrita apenas a membros oficiais e administradores
  useEffect(() => {
    if (!authReady || !firebaseUser || !capabilities.isOfficialMember) {
      setSystemSettings(null);
      return;
    }

    const unsubSettings = onSnapshot(
      doc(db, 'systemSettings', 'global'),
      (snap) => {
        setSystemSettings(snap.exists() ? (snap.data() as SystemSettings) : null);
      },
      () => {
        setSystemSettings(null);
      }
    );

    return () => unsubSettings();
  }, [authReady, firebaseUser, capabilities.isOfficialMember]);

  const signInWithCode = async (code: string, password: string): Promise<SignInResult> => {
    const normalized = normalizePlayerCode(code);
    if (normalized.length < 3 || normalized.length > 20) {
      throw new Error('Informe um Code válido (3 a 20 caracteres alfanuméricos).');
    }

    const internalId = codeToInternalAuthId(normalized);
    const cred = await signInWithEmailAndPassword(auth, internalId, password);
    await ensureBasicUserDocument(cred.user);

    const [uSnap, aSnap, tokenRes] = await Promise.all([
      getDoc(doc(db, 'users', cred.user.uid)),
      getDoc(doc(db, 'admins', cred.user.uid)).catch(() => null),
      cred.user.getIdTokenResult().catch(() => null),
    ]);
    const uData = uSnap.exists() ? (uSnap.data() as UserPrivate) : null;
    const aData = aSnap && aSnap.exists() ? (aSnap.data() as AdminGrant) : null;
    const claims = tokenRes
      ? {
          primaryAdmin: tokenRes.claims.primaryAdmin === true,
          cms: tokenRes.claims.cms === true,
        }
      : {};
    const caps = resolveUnifiedCapabilities(uData, aData, claims);

    return {
      user: cred.user,
      isOfficialMember: caps.isOfficialMember,
    };
  };

  const signInWithProfile = async (uid: string, password: string): Promise<SignInResult> => {
    if (!uid.trim()) {
      throw new Error('Perfil inválido para login.');
    }
    if (!password) {
      throw new Error('Informe sua senha.');
    }

    const res = await apiFetch<{ ok: boolean; customToken: string }>('/api/auth/login-profile', {
      method: 'POST',
      requireAuth: false,
      body: { uid, password },
    });

    const cred = await signInWithCustomToken(auth, res.customToken);
    await ensureBasicUserDocument(cred.user);

    const [uSnap, aSnap, tokenRes] = await Promise.all([
      getDoc(doc(db, 'users', cred.user.uid)),
      getDoc(doc(db, 'admins', cred.user.uid)).catch(() => null),
      cred.user.getIdTokenResult(true).catch(() => null),
    ]);
    const uData = uSnap.exists() ? (uSnap.data() as UserPrivate) : null;
    const aData = aSnap && aSnap.exists() ? (aSnap.data() as AdminGrant) : null;
    const claims = tokenRes
      ? {
          primaryAdmin: tokenRes.claims.primaryAdmin === true,
          cms: tokenRes.claims.cms === true,
        }
      : {};
    const caps = resolveUnifiedCapabilities(uData, aData, claims);

    return {
      user: cred.user,
      isOfficialMember: caps.isOfficialMember,
    };
  };

  const registerWithCode = async ({
    fullName,
    nick,
    code,
    password,
  }: RegisterWithCodeInput): Promise<User> => {
    const normalized = normalizePlayerCode(code);
    if (normalized.length < 3 || normalized.length > 20) {
      throw new Error('O Code deve ter entre 3 e 20 caracteres (letras, números, _ ou -).');
    }

    const cleanNick = nick.trim().slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
    const cleanFullName = fullName.trim().slice(0, BLUEPRINT_LIMITS.FULL_NAME_MAX);
    if (cleanFullName.length < 2 || cleanNick.length < 2) {
      throw new Error('Informe Nome e Nick válidos.');
    }

    const internalId = codeToInternalAuthId(normalized);
    const regPayload = {
      email: internalId,
      fullName: cleanFullName,
      nick: cleanNick,
      code: formatPlayerCode(normalized),
    };
    pendingRegistrationRef.current = regPayload;
    try {
      const cred = await createUserWithEmailAndPassword(auth, internalId, password);
      await updateProfile(cred.user, { displayName: cleanNick });
      await ensureBasicUserDocument(cred.user, regPayload);
      return cred.user;
    } finally {
      pendingRegistrationRef.current = null;
    }
  };

  const reauthenticateRecent = async (password: string) => {
    const user = auth.currentUser;
    if (!user || !user.email) {
      throw new Error('Sessão inválida para reautenticação.');
    }
    const credential = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, credential);
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    const user = auth.currentUser;
    if (!user) throw new Error('Nenhuma sessão ativa.');
    await reauthenticateRecent(currentPassword);
    await updatePassword(user, newPassword);
  };

  const refreshClaims = async () => {
    const user = auth.currentUser;
    if (!user) return;
    const res = await user.getIdTokenResult(true);
    setTokenClaims({
      primaryAdmin: res.claims.primaryAdmin === true,
      cms: res.claims.cms === true,
    });
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        authReady,
        profileDocsReady,
        userDoc,
        adminGrant,
        publicProfile,
        systemSettings,
        capabilities,
        unreadNotifications,
        signInWithCode,
        signInWithProfile,
        registerWithCode,
        reauthenticateRecent,
        changePassword,
        refreshClaims,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser utilizado dentro de AuthProvider.');
  return ctx;
}
