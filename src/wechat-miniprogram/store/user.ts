import { getStoredUser, hasValidToken, logout } from '../services/auth';
import type { UserProfile } from '../types/api';

interface UserState {
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

type Listener = (state: UserState) => void;

class UserStore {
  private state: UserState = {
    user: null,
    isAuthenticated: false,
    isLoading: true,
  };

  private listeners = new Set<Listener>();

  constructor() {
    this.hydrate();
  }

  // 从本地存储恢复状态
  private hydrate(): void {
    const user = getStoredUser();
    const authed = hasValidToken();
    this.state = {
      user,
      isAuthenticated: authed && !!user,
      isLoading: false,
    };
  }

  getState(): UserState {
    return { ...this.state };
  }

  setUser(user: UserProfile): void {
    this.state.user = user;
    this.state.isAuthenticated = hasValidToken();
    this.emit();
  }

  setLoading(loading: boolean): void {
    this.state.isLoading = loading;
    this.emit();
  }

  clear(): void {
    logout();
    this.state.user = null;
    this.state.isAuthenticated = false;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = { ...this.state };
    this.listeners.forEach((fn) => fn(state));
  }
}

export const userStore = new UserStore();
