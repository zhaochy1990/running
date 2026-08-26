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

  // 认证流程 settle（不管成功还是跳转登录页）时 resolve。数据页 await 后再发
  // 数据请求，避免首屏请求在异步登录完成前发出（无 token / 过期 token）被 401。
  private authReadyResolve: (() => void) | undefined;
  readonly authReady: Promise<void>;

  constructor() {
    this.authReady = new Promise<void>((resolve) => {
      this.authReadyResolve = resolve;
    });
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

  // 数据页用：等认证流程 settle 后再取 user / 发请求，避免 401（先认证后取数）。
  waitForAuth(): Promise<void> {
    return this.authReady;
  }

  setUser(user: UserProfile): void {
    this.state.user = user;
    this.state.isAuthenticated = hasValidToken();
    this.emit();
  }

  setLoading(loading: boolean): void {
    this.state.isLoading = loading;
    if (!loading) {
      this.authReadyResolve?.();
    }
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
