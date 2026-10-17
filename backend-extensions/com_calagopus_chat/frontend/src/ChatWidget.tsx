import {
  faArrowLeft,
  faComments,
  faMinus,
  faPaperPlane,
  faPlus,
  faRobot,
  faTrash,
  faUser,
  faUsers,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { z } from 'zod';
import { httpErrorToHuman } from '@/api/axios.ts';
import { useUserSetting, useUserSettingsLoaded } from '@/lib/userSettings.ts';
import { useAuth } from '@/providers/AuthProvider.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import createConversation from './api/createConversation.ts';
import decideAiServerAction from './api/decideAiServerAction.ts';
import deleteConversationApi from './api/deleteConversation.ts';
import getChatServerResources from './api/getChatServerResources.ts';
import getChatServers from './api/getChatServers.ts';
import getConversations from './api/getConversations.ts';
import getMessages from './api/getMessages.ts';
import getUsers from './api/getUsers.ts';
import markConversationRead from './api/markConversationRead.ts';
import postMessage from './api/sendMessage.ts';
import type {
  ChatMessage,
  ChatServerOption,
  ChatServerResources,
  ChatUser,
  Conversation,
  ConversationKind,
} from './lib/schemas.ts';
import { useExtTranslations } from './translations.ts';

function conversationIcon(kind: ConversationKind, aiEnabled = false) {
  if (kind === 'ai' || aiEnabled) return faRobot;
  if (kind === 'group') return faUsers;
  return faUser;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [days > 0 ? `${days}d` : '', hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : ''].filter(
    Boolean,
  );

  return parts.length > 0 ? parts.join(' ') : `${Math.floor(seconds)}s`;
}

function explicitlyMentionsAi(content: string): boolean {
  return content.split(/\s+/).some((word) => word.replace(/^[^\w@]+|[^\w@]+$/g, '').toLowerCase() === '@ai');
}

type ChatWidgetMode = 'widget' | 'page';
type ChatWidgetSize = { width: number; height: number };
type ChatServerStatusResult = {
  conversationUuid: string;
  server: ChatServerOption;
  resources: ChatServerResources;
};
type ChatServerResourcesError = { kind: 'unavailable' } | { kind: 'request'; message: string };
type ChatWidgetResizeOrigin = ChatWidgetSize & {
  pointerId: number;
  pointerX: number;
  pointerY: number;
};

export default function ChatWidget({ mode = 'widget' }: { mode?: ChatWidgetMode } = {}) {
  const { user } = useAuth();
  if (!user) return null;

  return <ChatWidgetSession key={user.uuid} mode={mode} />;
}

function ChatWidgetSession({ mode }: { mode: ChatWidgetMode }) {
  const isPage = mode === 'page';
  const { user } = useAuth();
  const { addToast } = useToast();
  const { t: tExt } = useExtTranslations();
  const { t: tPanel } = useTranslations();
  const [sendOnEnter, setSendOnEnter] = useUserSetting('com.calagopus.chat::send_on_enter', z.boolean(), true);
  const [hasSeenAiOnboarding, setHasSeenAiOnboarding] = useUserSetting(
    'com.calagopus.chat::ai_onboarding_seen',
    z.boolean(),
    false,
  );
  const userSettingsLoaded = useUserSettingsLoaded();
  const [aiOnboardingOpen, setAiOnboardingOpen] = useState(false);
  const [expanded, setExpanded] = useState(isPage);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [floatingWidgetEnabled, setFloatingWidgetEnabled] = useState<boolean | null>(null);
  const [activeConversationUuid, setActiveConversationUuid] = useState<string | null>(null);
  const activeConversationUuidRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [aiReplyPendingConversationUuid, setAiReplyPendingConversationUuid] = useState<string | null>(null);
  const [serverStatusModalOpen, setServerStatusModalOpen] = useState(false);
  const [serverSearch, setServerSearch] = useState('');
  const [chatServers, setChatServers] = useState<ChatServerOption[]>([]);
  const [chatServersLoading, setChatServersLoading] = useState(false);
  const [chatServersTruncated, setChatServersTruncated] = useState(false);
  const [chatServersError, setChatServersError] = useState<string | null>(null);
  const [selectedServerUuid, setSelectedServerUuid] = useState<string | null>(null);
  const [serverResourcesLoading, setServerResourcesLoading] = useState(false);
  const [serverResourcesError, setServerResourcesError] = useState<ChatServerResourcesError | null>(null);
  const [serverStatusResult, setServerStatusResult] = useState<ChatServerStatusResult | null>(null);
  const [composeMode, setComposeMode] = useState<ConversationKind | null>(null);
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupAiEnabled, setGroupAiEnabled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
  const [deletingConversationUuid, setDeletingConversationUuid] = useState<string | null>(null);
  const [processingServerActionMessageUuid, setProcessingServerActionMessageUuid] = useState<string | null>(null);
  const [floatingSize, setFloatingSize] = useState<ChatWidgetSize | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<HTMLElement | null>(null);
  const resizeOriginRef = useRef<ChatWidgetResizeOrigin | null>(null);
  activeConversationUuidRef.current = activeConversationUuid;

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isPage || window.innerWidth < 768) return;

    const shell = widgetRef.current?.querySelector('.calagopus-chat-shell');
    const bounds = shell?.getBoundingClientRect();
    if (!bounds) return;

    resizeOriginRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = resizeOriginRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;

    const maxWidth = Math.max(340, Math.min(window.innerWidth - 32, 1000));
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const maxHeight = Math.max(430, Math.min(viewportHeight - 32, 1000));
    setFloatingSize({
      width: Math.round(Math.min(maxWidth, Math.max(340, origin.width + origin.pointerX - event.clientX))),
      height: Math.round(Math.min(maxHeight, Math.max(430, origin.height + origin.pointerY - event.clientY))),
    });
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeOriginRef.current?.pointerId !== event.pointerId) return;

    resizeOriginRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateViewport = () => {
      const element = widgetRef.current;
      if (!element) return;

      const bottomInset = expanded ? Math.max(0, window.innerHeight - viewport.offsetTop - viewport.height) : 0;
      element.style.setProperty('--calagopus-visual-viewport-height', `${viewport.height}px`);
      element.style.setProperty('--calagopus-visual-viewport-bottom-inset', `${bottomInset}px`);
    };

    updateViewport();
    viewport.addEventListener('resize', updateViewport);
    viewport.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      viewport.removeEventListener('resize', updateViewport);
      viewport.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      widgetRef.current?.style.removeProperty('--calagopus-visual-viewport-height');
      widgetRef.current?.style.removeProperty('--calagopus-visual-viewport-bottom-inset');
    };
  }, [expanded]);

  const unreadCount = useMemo(
    () => conversations.reduce((total, conversation) => total + conversation.unreadCount, 0),
    [conversations],
  );
  const activeConversation = conversations.find((conversation) => conversation.uuid === activeConversationUuid);
  const isAiConversation =
    activeConversation?.kind === 'ai' || (activeConversation?.kind === 'group' && activeConversation.aiEnabled);
  const selectedChatServer = chatServers.find((server) => server.uuid === selectedServerUuid);
  const activeServerStatusResult =
    serverStatusResult?.conversationUuid === activeConversationUuid ? serverStatusResult : null;
  const getConversationTitle = (conversation: Conversation | undefined): string => {
    if (!conversation) return tExt('chat.conversation', {});
    if (conversation.kind === 'ai') return tExt('chat.aiTitle', {});
    if (conversation.kind === 'group') {
      if (conversation.title === 'Group chat') return tExt('chat.groupFallback', {});
      return conversation.title || conversation.participants.join(', ') || tExt('chat.groupFallback', {});
    }
    return conversation.participants[0] ?? tExt('chat.directFallback', {});
  };
  const getConversationPreview = (conversation: Conversation): string => {
    switch (conversation.lastActionStatus) {
      case 'pending':
        return tExt('chat.actionPendingPreview', {});
      case 'executing':
        return tExt('chat.serverActionExecuting', {});
      case 'confirmed':
        return tExt('chat.serverActionConfirmed', {});
      case 'cancelled':
        return tExt('chat.serverActionCancelled', {});
      case 'failed':
        return tExt('chat.serverActionFailed', {});
      case 'expired':
        return tExt('chat.serverActionExpired', {});
      default:
        return (
          conversation.lastMessage ??
          (conversation.kind === 'ai' ? tExt('chat.composeTitle', {}) : tExt('chat.noMessagesPreview', {}))
        );
    }
  };

  const loadConversations = useCallback(
    async (silent = false) => {
      try {
        const response = await getConversations();
        setConversations(response.conversations);
        setAiAvailable(response.aiAvailable);
        setFloatingWidgetEnabled(response.floatingWidgetEnabled);
      } catch (error) {
        if (!silent) addToast(httpErrorToHuman(error), 'error');
      }
    },
    [addToast],
  );

  useEffect(() => {
    if (!user) return;

    let active = true;
    const load = async (silent: boolean) => {
      try {
        if (!silent && expanded) setListLoading(true);
        const response = await getConversations();
        if (!active) return;
        setConversations(response.conversations);
        setAiAvailable(response.aiAvailable);
        setFloatingWidgetEnabled(response.floatingWidgetEnabled);
      } catch (error) {
        if (active && !silent) addToast(httpErrorToHuman(error), 'error');
      } finally {
        if (active && !silent && expanded) setListLoading(false);
      }
    };

    void load(!expanded);
    const interval = window.setInterval(() => void load(true), expanded ? 6000 : 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [expanded, user, addToast]);

  useEffect(() => {
    if (!expanded || !isAiConversation) {
      setAiOnboardingOpen(false);
      return;
    }

    if (!user || !userSettingsLoaded || !aiAvailable || hasSeenAiOnboarding) return;
    setAiOnboardingOpen(true);
  }, [expanded, isAiConversation, user, userSettingsLoaded, aiAvailable, hasSeenAiOnboarding]);

  useEffect(() => {
    if (!serverStatusModalOpen) return;

    let active = true;
    setChatServersLoading(true);
    setChatServersError(null);
    const timeout = window.setTimeout(
      () => {
        getChatServers(serverSearch)
          .then(({ servers: result, truncated }) => {
            if (!active) return;
            setChatServers(result);
            setChatServersTruncated(truncated);
          })
          .catch((error) => {
            if (active) setChatServersError(httpErrorToHuman(error));
          })
          .finally(() => {
            if (active) setChatServersLoading(false);
          });
      },
      serverSearch ? 250 : 0,
    );

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [serverStatusModalOpen, serverSearch]);

  useEffect(() => {
    if (!serverStatusModalOpen || !selectedServerUuid) {
      setServerResourcesLoading(false);
      setServerResourcesError(null);
      return;
    }

    let active = true;
    setServerResourcesLoading(true);
    setServerResourcesError(null);
    getChatServerResources(selectedServerUuid)
      .then((resources) => {
        if (!active) return;
        if (!selectedChatServer || !activeConversationUuid) {
          setServerResourcesError({ kind: 'unavailable' });
          return;
        }
        setServerStatusResult({
          conversationUuid: activeConversationUuid,
          server: selectedChatServer,
          resources,
        });
        setServerStatusModalOpen(false);
      })
      .catch((error) => {
        if (active) {
          setServerResourcesError({ kind: 'request', message: httpErrorToHuman(error) });
        }
      })
      .finally(() => {
        if (active) setServerResourcesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [serverStatusModalOpen, selectedServerUuid, selectedChatServer, activeConversationUuid]);

  useEffect(() => {
    if (!expanded || !user || !activeConversationUuid) return;

    let active = true;
    let initialized = false;
    let lastReadMessageUuid: string | null = null;

    const load = async (silent: boolean) => {
      try {
        if (!silent) setMessagesLoading(true);
        const response = await getMessages(activeConversationUuid);
        if (!active) return;
        setMessages(response.messages);

        const lastMessage = response.messages[response.messages.length - 1]?.uuid ?? null;
        if (!initialized || lastMessage !== lastReadMessageUuid) {
          initialized = true;
          lastReadMessageUuid = lastMessage;
          try {
            await markConversationRead(activeConversationUuid);
            if (active) void loadConversations(true);
          } catch (error) {
            initialized = false;
            throw error;
          }
        }
      } catch (error) {
        if (active && !silent) addToast(httpErrorToHuman(error), 'error');
      } finally {
        if (active && !silent) setMessagesLoading(false);
      }
    };

    void load(false);
    const interval = window.setInterval(() => void load(true), 4000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [expanded, user, activeConversationUuid, addToast, loadConversations]);

  useEffect(() => {
    const element = messageListRef.current;
    if (!element) return;

    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [messages, aiReplyPendingConversationUuid, serverStatusResult, activeConversationUuid]);

  useEffect(() => {
    if (!expanded || !user || !composeMode || composeMode === 'ai') return;

    let active = true;
    setUsersLoading(true);
    const timeout = window.setTimeout(() => {
      getUsers(search)
        .then((response) => {
          if (active) setUsers(response.users);
        })
        .catch((error) => {
          if (active) addToast(httpErrorToHuman(error), 'error');
        })
        .finally(() => {
          if (active) setUsersLoading(false);
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [expanded, user, composeMode, search, addToast]);

  const startConversation = async (
    kind: ConversationKind,
    participantUuids: string[] = [],
    title?: string,
    aiEnabled = false,
  ) => {
    setCreating(true);
    try {
      const response = await createConversation({ kind, participantUuids, title, aiEnabled });
      setMessages([]);
      setActiveConversationUuid(response.conversation.uuid);
      setComposeMode(null);
      setSelectedUsers([]);
      setGroupTitle('');
      setGroupAiEnabled(false);
      setSearch('');
      void loadConversations(true);
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setCreating(false);
    }
  };

  const openServerStatus = (searchTerm = '') => {
    setDraft('');
    setServerSearch(searchTerm.trim().slice(0, 128));
    setChatServers([]);
    setChatServersTruncated(false);
    setChatServersError(null);
    setSelectedServerUuid(null);
    setServerResourcesError(null);
    setServerStatusResult(null);
    setServerStatusModalOpen(true);
  };

  const completeAiOnboarding = () => {
    setAiOnboardingOpen(false);
    setHasSeenAiOnboarding(true);
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const conversationUuid = activeConversationUuid;
    const content = draft.trim();
    if (!conversationUuid || !content || sending) return;
    const statusCommand = content.match(/^\/status(?:\s+(.*))?$/i);
    if (activeConversation?.kind === 'ai' && !aiAvailable && !statusCommand) return;
    if (statusCommand) {
      openServerStatus(statusCommand[1] ?? '');
      return;
    }

    const aiWillRespond =
      activeConversation?.kind === 'ai' ||
      (activeConversation?.kind === 'group' && activeConversation.aiEnabled && explicitlyMentionsAi(content));

    setSending(true);
    setDraft('');
    if (aiWillRespond) setAiReplyPendingConversationUuid(conversationUuid);
    try {
      await postMessage(conversationUuid, content);
      if (aiWillRespond) setAiReplyPendingConversationUuid(null);
      const response = await getMessages(conversationUuid);
      setMessages(response.messages);
      await markConversationRead(conversationUuid);
      await loadConversations(true);
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 502) {
        void getMessages(conversationUuid)
          .then((response) => setMessages(response.messages))
          .catch(() => undefined);
        void loadConversations(true);
      } else {
        setDraft(content);
      }
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      if (aiWillRespond) setAiReplyPendingConversationUuid(null);
      setSending(false);
    }
  };

  const slashCommandToken = draft.trimStart().split(/\s+/, 1)[0].toLowerCase();
  const showStatusCommandSuggestion = slashCommandToken.startsWith('/') && '/status'.startsWith(slashCommandToken);
  const statusCommandSearch = draft.trim().match(/^\/status(?:\s+(.*))?$/i)?.[1] ?? '';
  const isStatusCommandDraft = /^\/status(?:\s+.*)?$/i.test(draft.trim());

  const openNewChat = () => {
    setActiveConversationUuid(null);
    setComposeMode('direct');
    setSearch('');
    setUsers([]);
    setSelectedUsers([]);
    setGroupTitle('');
    setGroupAiEnabled(false);
  };

  const confirmDeleteChat = async () => {
    if (!conversationToDelete || deletingConversationUuid) return;

    const conversation = conversationToDelete;
    setDeletingConversationUuid(conversation.uuid);
    try {
      await deleteConversationApi(conversation.uuid);
      setConversations((current) => current.filter((item) => item.uuid !== conversation.uuid));
      if (activeConversationUuid === conversation.uuid) {
        setActiveConversationUuid(null);
        setMessages([]);
      }
      setConversationToDelete(null);
      addToast(tExt('chat.conversationDeleted', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setDeletingConversationUuid(null);
    }
  };

  const decideServerAction = async (messageUuid: string, confirm: boolean) => {
    if (!activeConversationUuid || processingServerActionMessageUuid) return;

    setProcessingServerActionMessageUuid(messageUuid);
    try {
      const response = await decideAiServerAction(activeConversationUuid, messageUuid, confirm);
      setMessages((current) =>
        current.map((message) =>
          message.uuid === messageUuid && message.pendingAction
            ? {
                ...message,
                pendingAction: { ...message.pendingAction, status: response.status },
              }
            : message,
        ),
      );
      addToast(
        response.status === 'confirmed'
          ? tExt('chat.serverActionSubmitted', {})
          : response.status === 'cancelled'
            ? tExt('chat.serverActionCancelled', {})
            : response.status === 'expired'
              ? tExt('chat.serverActionExpired', {})
              : tExt('chat.serverActionFailed', {}),
        response.status === 'confirmed' || response.status === 'cancelled' ? 'success' : 'warning',
      );
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
      const conversationUuid = activeConversationUuid;
      void getMessages(conversationUuid)
        .then((response) => {
          setMessages((current) =>
            activeConversationUuidRef.current === conversationUuid ? response.messages : current,
          );
        })
        .catch(() => undefined);
    } finally {
      setProcessingServerActionMessageUuid(null);
    }
  };

  if (!user || (!isPage && floatingWidgetEnabled === false)) return null;

  if (isPage && floatingWidgetEnabled !== false) {
    return floatingWidgetEnabled === null ? (
      <Group justify='center' py='xl'>
        <Loader size='sm' />
        <Text size='sm' c='dimmed'>
          {tExt('chat.loadingPageMode', {})}
        </Text>
      </Group>
    ) : (
      <Paper withBorder radius='md' p='lg' className='calagopus-chat-page-mode-notice'>
        <Stack gap='xs'>
          <Text fw={700}>{tExt('chat.pageModeUnavailableTitle', {})}</Text>
          <Text size='sm' c='dimmed'>
            {tExt('chat.pageModeUnavailableDescription', {})}
          </Text>
        </Stack>
      </Paper>
    );
  }

  return (
    <aside
      ref={widgetRef}
      className={`calagopus-chat-widget${expanded || isPage ? ' is-expanded' : ''}${isPage ? ' is-page' : ''}`}
      aria-label={tExt('chat.brand', {})}
    >
      {!expanded && !isPage ? (
        <button
          type='button'
          className='calagopus-chat-collapsed'
          aria-label={unreadCount > 0 ? tExt('chat.openUnread', { count: unreadCount }) : tExt('chat.open', {})}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <span className='calagopus-chat-brand-icon'>
            <FontAwesomeIcon icon={faComments} aria-hidden='true' />
          </span>
          <span className='calagopus-chat-collapsed-copy'>
            <span className='calagopus-chat-collapsed-title'>{tExt('chat.collapsedTitle', {})}</span>
            <span className='calagopus-chat-collapsed-subtitle'>{tExt('chat.collapsedSubtitle', {})}</span>
          </span>
          {unreadCount > 0 && (
            <Badge size='sm' color='blue' variant='filled' aria-label={tExt('chat.unread', { count: unreadCount })}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </button>
      ) : (
        <div
          className='calagopus-chat-shell'
          style={!isPage && floatingSize ? { width: floatingSize.width, height: floatingSize.height } : undefined}
        >
          {!isPage && (
            <button
              type='button'
              className='calagopus-chat-resize-handle'
              aria-label={tExt('chat.resizeWindow', {})}
              title={tExt('chat.resizeWindow', {})}
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            >
              <span aria-hidden='true' />
            </button>
          )}
          <header className='calagopus-chat-header'>
            {(activeConversationUuid || composeMode) && (
              <Tooltip label={tExt('chat.back', {})}>
                <ActionIcon
                  variant='subtle'
                  aria-label={tExt('chat.back', {})}
                  onClick={() => {
                    setActiveConversationUuid(null);
                    setComposeMode(null);
                  }}
                >
                  <FontAwesomeIcon icon={faArrowLeft} aria-hidden='true' />
                </ActionIcon>
              </Tooltip>
            )}
            <span className='calagopus-chat-brand-icon'>
              <FontAwesomeIcon
                icon={
                  activeConversation
                    ? conversationIcon(activeConversation.kind, activeConversation.aiEnabled)
                    : faComments
                }
                aria-hidden='true'
              />
            </span>
            <div className='calagopus-chat-header-copy'>
              <Text fw={700} size='sm' truncate>
                {activeConversationUuid
                  ? getConversationTitle(activeConversation)
                  : composeMode
                    ? tExt('chat.composeTitle', {})
                    : tExt('chat.brand', {})}
              </Text>
              <Text size='xs' c='dimmed' truncate>
                {activeConversation?.kind === 'ai'
                  ? tExt('chat.privateAiSubtitle', {})
                  : activeConversationUuid
                    ? activeConversation?.kind === 'group'
                      ? activeConversation.aiEnabled
                        ? tExt('chat.groupAiSubtitle', {})
                        : tExt('chat.groupSubtitle', {})
                      : tExt('chat.directSubtitle', {})
                    : composeMode
                      ? tExt('chat.composeSubtitle', {})
                      : tExt('chat.listSubtitle', {})}
              </Text>
            </div>
            {unreadCount > 0 && (
              <Badge size='sm' color='blue' variant='filled' aria-label={tExt('chat.unread', { count: unreadCount })}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </Badge>
            )}
            {!activeConversationUuid && !composeMode && (
              <Tooltip label={tExt('chat.newConversation', {})}>
                <ActionIcon variant='subtle' aria-label={tExt('chat.newConversation', {})} onClick={openNewChat}>
                  <FontAwesomeIcon icon={faPlus} aria-hidden='true' />
                </ActionIcon>
              </Tooltip>
            )}
            {!isPage && (
              <Tooltip label={tExt('chat.minimize', {})}>
                <ActionIcon variant='subtle' aria-label={tExt('chat.minimize', {})} onClick={() => setExpanded(false)}>
                  <FontAwesomeIcon icon={faMinus} aria-hidden='true' />
                </ActionIcon>
              </Tooltip>
            )}
          </header>

          {activeConversationUuid ? (
            <div className='calagopus-chat-conversation'>
              <div className='calagopus-chat-messages' ref={messageListRef}>
                {messagesLoading && messages.length === 0 ? (
                  <div className='calagopus-chat-centered-state'>
                    <Loader size='sm' />
                  </div>
                ) : messages.length === 0 && !activeServerStatusResult ? (
                  <div className='calagopus-chat-centered-state'>
                    <Text size='sm' c='dimmed'>
                      {tExt('chat.noMessages', {})}
                    </Text>
                  </div>
                ) : (
                  <Stack gap='xs'>
                    {messages.map((message) => (
                      <MessageBubble
                        key={message.uuid}
                        message={message}
                        own={message.senderUuid === user.uuid}
                        senderLabel={
                          message.isAi
                            ? tExt('chat.aiTitle', {})
                            : message.senderUuid
                              ? message.senderUsername
                              : tExt('chat.formerUser', {})
                        }
                        onServerActionDecision={(confirm) => void decideServerAction(message.uuid, confirm)}
                        serverActionLoading={processingServerActionMessageUuid === message.uuid}
                        serverActionDisabled={processingServerActionMessageUuid !== null}
                      />
                    ))}
                    {aiReplyPendingConversationUuid === activeConversationUuid && (
                      <div
                        className='calagopus-chat-message is-ai calagopus-chat-typing-message'
                        role='status'
                        aria-label={tExt('chat.aiTyping', {})}
                      >
                        <Text className='calagopus-chat-message-author' size='xs' c='dimmed'>
                          {tExt('chat.aiTitle', {})}
                        </Text>
                        <Paper withBorder radius='md' p='xs' className='calagopus-chat-message-paper'>
                          <span className='calagopus-chat-typing-dots' aria-hidden='true'>
                            <span />
                            <span />
                            <span />
                          </span>
                        </Paper>
                      </div>
                    )}
                  </Stack>
                )}
                {activeServerStatusResult && (
                  <div className='calagopus-chat-message is-ai calagopus-chat-server-status-message'>
                    <Text className='calagopus-chat-message-author' size='xs' c='dimmed'>
                      {tExt('chat.serverStatusResultAuthor', {})}
                    </Text>
                    <Paper withBorder radius='md' p='sm' className='calagopus-chat-message-paper'>
                      <Group justify='space-between' align='flex-start'>
                        <div>
                          <Text fw={700}>{activeServerStatusResult.server.name}</Text>
                          <Text size='xs' c='dimmed'>
                            {activeServerStatusResult.server.uuidShort}
                          </Text>
                        </div>
                        <Group gap='xs'>
                          {activeServerStatusResult.server.isSuspended && (
                            <Badge color='red'>{tExt('chat.statusSuspended', {})}</Badge>
                          )}
                          <Badge color={activeServerStatusResult.resources.state === 'running' ? 'green' : 'gray'}>
                            {activeServerStatusResult.resources.state}
                          </Badge>
                        </Group>
                      </Group>
                      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='xs' mt='sm'>
                        <div>
                          <Text size='xs' c='dimmed'>
                            {tExt('chat.statusCpu', {})}
                          </Text>
                          <Text size='sm'>
                            {activeServerStatusResult.resources.cpuAbsolute.toFixed(1)}% /{' '}
                            {activeServerStatusResult.resources.cpuLimitAbsolute}%
                          </Text>
                        </div>
                        <div>
                          <Text size='xs' c='dimmed'>
                            {tExt('chat.statusMemory', {})}
                          </Text>
                          <Text size='sm'>
                            {formatBytes(activeServerStatusResult.resources.memoryBytes)} /{' '}
                            {formatBytes(activeServerStatusResult.resources.memoryLimitBytes)}
                          </Text>
                        </div>
                        <div>
                          <Text size='xs' c='dimmed'>
                            {tExt('chat.statusDisk', {})}
                          </Text>
                          <Text size='sm'>{formatBytes(activeServerStatusResult.resources.diskBytes)}</Text>
                        </div>
                        <div>
                          <Text size='xs' c='dimmed'>
                            {tExt('chat.statusUptime', {})}
                          </Text>
                          <Text size='sm'>{formatUptime(activeServerStatusResult.resources.uptime)}</Text>
                        </div>
                        {activeServerStatusResult.server.status && (
                          <div>
                            <Text size='xs' c='dimmed'>
                              {tExt('chat.statusInstall', {})}
                            </Text>
                            <Text size='sm'>{activeServerStatusResult.server.status}</Text>
                          </div>
                        )}
                      </SimpleGrid>
                      <Group justify='flex-end' mt='xs'>
                        <Button size='xs' variant='subtle' onClick={() => setServerStatusResult(null)}>
                          {tExt('chat.dismissStatusResult', {})}
                        </Button>
                      </Group>
                    </Paper>
                  </div>
                )}
              </div>
              <form className='calagopus-chat-composer' onSubmit={send}>
                {showStatusCommandSuggestion && (
                  <Paper withBorder radius='sm' p={4} className='calagopus-chat-slash-suggestion'>
                    <button
                      type='button'
                      className='calagopus-chat-slash-command'
                      onClick={() => openServerStatus(statusCommandSearch)}
                    >
                      <Text size='sm' fw={600}>
                        /status
                      </Text>
                      <Text size='xs' c='dimmed'>
                        {tExt('chat.statusCommandDescription', {})}
                      </Text>
                    </button>
                  </Paper>
                )}
                <Group className='calagopus-chat-composer-options' justify='space-between' gap='xs'>
                  <Switch
                    size='xs'
                    label={tExt('chat.enterSends', {})}
                    checked={sendOnEnter}
                    onChange={(event) => setSendOnEnter(event.currentTarget.checked)}
                  />
                  <Text size='xs' c='dimmed'>
                    {sendOnEnter ? tExt('chat.shiftEnterNewLine', {}) : tExt('chat.controlEnterSends', {})}
                  </Text>
                </Group>
                <div className='calagopus-chat-composer-row'>
                  <Textarea
                    aria-label={tExt('chat.writeMessage', {})}
                    placeholder={tExt('chat.messagePlaceholder', {})}
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    enterKeyHint={sendOnEnter ? 'send' : 'enter'}
                    onKeyDown={(event) => {
                      const sendShortcut = sendOnEnter
                        ? event.key === 'Enter' && !event.shiftKey
                        : event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey;
                      if (sendShortcut) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    minRows={1}
                    maxRows={4}
                    autosize
                    maxLength={4000}
                    disabled={sending}
                  />
                  <Tooltip
                    label={sendOnEnter ? tExt('chat.sendTooltipEnter', {}) : tExt('chat.sendTooltipControlEnter', {})}
                  >
                    <ActionIcon
                      type='submit'
                      size='lg'
                      variant='filled'
                      aria-label={tPanel('common.button.send', {})}
                      disabled={
                        !draft.trim() ||
                        sending ||
                        (activeConversation?.kind === 'ai' && !aiAvailable && !isStatusCommandDraft)
                      }
                      loading={sending}
                    >
                      <FontAwesomeIcon icon={faPaperPlane} aria-hidden='true' />
                    </ActionIcon>
                  </Tooltip>
                </div>
              </form>
              {activeConversation?.aiEnabled && !aiAvailable && (
                <Text className='calagopus-chat-ai-notice' size='xs' c='dimmed'>
                  {activeConversation.kind === 'ai' ? tExt('chat.aiNotConfigured', {}) : tExt('chat.aiUnavailable', {})}
                </Text>
              )}
            </div>
          ) : composeMode ? (
            <div className='calagopus-chat-compose'>
              <Group grow gap='xs'>
                <Button
                  size='xs'
                  variant={composeMode === 'direct' ? 'filled' : 'default'}
                  onClick={() => {
                    setComposeMode('direct');
                    setSelectedUsers([]);
                    setGroupAiEnabled(false);
                  }}
                >
                  {tExt('chat.direct', {})}
                </Button>
                <Button
                  size='xs'
                  variant={composeMode === 'group' ? 'filled' : 'default'}
                  onClick={() => {
                    setComposeMode('group');
                    setSelectedUsers([]);
                  }}
                >
                  {tExt('chat.group', {})}
                </Button>
                <Button
                  size='xs'
                  variant={composeMode === 'ai' ? 'filled' : 'default'}
                  onClick={() => setComposeMode('ai')}
                  disabled={!aiAvailable}
                  leftSection={<FontAwesomeIcon icon={faRobot} aria-hidden='true' />}
                >
                  {tExt('chat.ai', {})}
                </Button>
              </Group>

              {composeMode === 'ai' ? (
                <Stack gap='sm' className='calagopus-chat-compose-ai'>
                  <Text size='sm' c='dimmed'>
                    {tExt('chat.privateAiDescription', {})}
                  </Text>
                  {!aiAvailable && (
                    <Paper withBorder radius='sm' p='sm'>
                      <Text size='sm' c='dimmed'>
                        {tExt('chat.aiUnavailable', {})}
                      </Text>
                    </Paper>
                  )}
                  <Button
                    onClick={() => void startConversation('ai')}
                    loading={creating}
                    disabled={!aiAvailable}
                    leftSection={<FontAwesomeIcon icon={faRobot} aria-hidden='true' />}
                  >
                    {tExt('chat.startAiChat', {})}
                  </Button>
                </Stack>
              ) : (
                <>
                  {composeMode === 'group' && (
                    <TextInput
                      label={tExt('chat.groupName', {})}
                      placeholder={tExt('chat.optionalGroupName', {})}
                      value={groupTitle}
                      onChange={(event) => setGroupTitle(event.currentTarget.value)}
                      maxLength={80}
                    />
                  )}
                  {composeMode === 'group' && (
                    <Stack gap={4}>
                      <Checkbox
                        label={tExt('chat.includeAiInGroup', {})}
                        checked={groupAiEnabled}
                        disabled={!aiAvailable}
                        onChange={(event) => setGroupAiEnabled(event.currentTarget.checked)}
                      />
                      <Text size='xs' c='dimmed'>
                        {aiAvailable ? tExt('chat.groupAiMentionHint', {}) : tExt('chat.aiUnavailable', {})}
                      </Text>
                    </Stack>
                  )}
                  <TextInput
                    aria-label={tExt('chat.searchUsers', {})}
                    placeholder={tPanel('common.input.search', {})}
                    value={search}
                    onChange={(event) => setSearch(event.currentTarget.value)}
                  />
                  {composeMode === 'group' && (
                    <Text size='xs' c='dimmed'>
                      {tExt('chat.selectGroupPeople', {})}
                    </Text>
                  )}
                  <div className='calagopus-chat-user-results'>
                    {usersLoading ? (
                      <div className='calagopus-chat-centered-state'>
                        <Loader size='sm' />
                      </div>
                    ) : users.length === 0 ? (
                      <Text size='sm' c='dimmed' ta='center' py='md'>
                        {tExt('chat.noUsersFound', {})}
                      </Text>
                    ) : (
                      <Stack gap={4}>
                        {users.map((chatUser) => (
                          <UserOption
                            key={chatUser.uuid}
                            user={chatUser}
                            selected={selectedUsers.includes(chatUser.uuid)}
                            groupMode={composeMode === 'group'}
                            disabled={creating}
                            onSelect={() => {
                              if (composeMode === 'direct') {
                                void startConversation('direct', [chatUser.uuid]);
                              } else {
                                setSelectedUsers((current) =>
                                  current.includes(chatUser.uuid)
                                    ? current.filter((uuid) => uuid !== chatUser.uuid)
                                    : [...current, chatUser.uuid],
                                );
                              }
                            }}
                          />
                        ))}
                      </Stack>
                    )}
                  </div>
                  {composeMode === 'group' && (
                    <Button
                      onClick={() => void startConversation('group', selectedUsers, groupTitle, groupAiEnabled)}
                      loading={creating}
                      disabled={selectedUsers.length < 2}
                      leftSection={<FontAwesomeIcon icon={faUsers} aria-hidden='true' />}
                    >
                      {tExt('chat.createGroup', { count: selectedUsers.length })}
                    </Button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className='calagopus-chat-list'>
              {listLoading && conversations.length === 0 ? (
                <div className='calagopus-chat-centered-state'>
                  <Loader size='sm' />
                </div>
              ) : conversations.length === 0 ? (
                <div className='calagopus-chat-centered-state calagopus-chat-empty'>
                  <FontAwesomeIcon icon={faComments} aria-hidden='true' />
                  <Text fw={600}>{tExt('chat.emptyTitle', {})}</Text>
                  <Text size='sm' c='dimmed' ta='center'>
                    {tExt('chat.emptyDescription', {})}
                  </Text>
                  <Button size='xs' onClick={openNewChat} leftSection={<FontAwesomeIcon icon={faPlus} />}>
                    {tExt('chat.newConversationButton', {})}
                  </Button>
                </div>
              ) : (
                <Stack gap={4}>
                  {conversations.map((conversation) => (
                    <div className='calagopus-chat-conversation-row' key={conversation.uuid}>
                      <button
                        type='button'
                        className='calagopus-chat-conversation-button'
                        aria-label={getConversationTitle(conversation)}
                        onClick={() => {
                          setMessages([]);
                          setActiveConversationUuid(conversation.uuid);
                        }}
                      >
                        <span className='calagopus-chat-row-icon'>
                          <FontAwesomeIcon
                            icon={conversationIcon(conversation.kind, conversation.aiEnabled)}
                            aria-hidden='true'
                          />
                        </span>
                        <span className='calagopus-chat-row-copy'>
                          <span className='calagopus-chat-row-title'>{getConversationTitle(conversation)}</span>
                          <span className='calagopus-chat-row-preview'>{getConversationPreview(conversation)}</span>
                        </span>
                        {conversation.kind === 'group' && conversation.aiEnabled && (
                          <Badge size='xs' color='violet' variant='light'>
                            {tExt('chat.ai', {})}
                          </Badge>
                        )}
                        {conversation.unreadCount > 0 && (
                          <Badge size='xs' color='blue' variant='filled'>
                            {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                          </Badge>
                        )}
                      </button>
                      <Tooltip label={tExt('chat.deleteConversation', {})}>
                        <ActionIcon
                          className='calagopus-chat-delete-action'
                          variant='subtle'
                          color='red'
                          aria-label={tExt('chat.deleteConversation', {})}
                          loading={deletingConversationUuid === conversation.uuid}
                          disabled={deletingConversationUuid !== null}
                          onClick={() => setConversationToDelete(conversation)}
                        >
                          <FontAwesomeIcon icon={faTrash} aria-hidden='true' />
                        </ActionIcon>
                      </Tooltip>
                    </div>
                  ))}
                </Stack>
              )}
            </div>
          )}
        </div>
      )}
      <Modal
        opened={conversationToDelete !== null}
        onClose={() => {
          if (deletingConversationUuid === null) setConversationToDelete(null);
        }}
        title={tExt('chat.deleteConversationTitle', {})}
        centered
        size='sm'
      >
        <Stack gap='md'>
          <Text size='sm'>
            {tExt('chat.deleteConversationDescription', {
              title: conversationToDelete ? getConversationTitle(conversationToDelete) : '',
            })}
          </Text>
          <Group justify='flex-end'>
            <Button
              variant='default'
              disabled={deletingConversationUuid !== null}
              onClick={() => setConversationToDelete(null)}
            >
              {tPanel('common.button.cancel', {})}
            </Button>
            <Button color='red' loading={deletingConversationUuid !== null} onClick={() => void confirmDeleteChat()}>
              {tExt('chat.deleteConversation', {})}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={aiOnboardingOpen}
        onClose={completeAiOnboarding}
        title={tExt('chat.aiOnboardingTitle', {})}
        centered
        size='lg'
      >
        <Stack gap='md'>
          <Text size='sm' c='dimmed'>
            {tExt('chat.aiOnboardingIntro', {})}
          </Text>
          <Paper withBorder radius='sm' p='sm'>
            <Stack gap='xs'>
              <Text fw={700}>{tExt('chat.aiOnboardingSafetyTitle', {})}</Text>
              <List size='sm' spacing='xs'>
                <List.Item>{tExt('chat.aiOnboardingSecrets', {})}</List.Item>
                <List.Item>{tExt('chat.aiOnboardingKeys', {})}</List.Item>
                <List.Item>{tExt('chat.aiOnboardingServerData', {})}</List.Item>
              </List>
            </Stack>
          </Paper>
          <Paper withBorder radius='sm' p='sm'>
            <Stack gap='xs'>
              <Text fw={700}>{tExt('chat.aiOnboardingUseTitle', {})}</Text>
              <List size='sm' spacing='xs'>
                <List.Item>{tExt('chat.aiOnboardingPrivateUse', {})}</List.Item>
                <List.Item>{tExt('chat.aiOnboardingGroupUse', {})}</List.Item>
                <List.Item>{tExt('chat.aiOnboardingStatusCommand', {})}</List.Item>
                <List.Item>{tExt('chat.aiOnboardingVerify', {})}</List.Item>
              </List>
            </Stack>
          </Paper>
          <Group justify='flex-end'>
            <Button onClick={completeAiOnboarding}>{tExt('chat.aiOnboardingDone', {})}</Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={serverStatusModalOpen}
        onClose={() => {
          setServerStatusModalOpen(false);
          setSelectedServerUuid(null);
        }}
        title={tExt('chat.statusCommand', {})}
        centered
        size='md'
      >
        <Stack gap='md'>
          <Text size='sm' c='dimmed'>
            {tExt('chat.statusCommandDescription', {})}
          </Text>
          <TextInput
            label={tExt('chat.statusServerSearch', {})}
            placeholder={tExt('chat.statusServerSearchPlaceholder', {})}
            value={serverSearch}
            onChange={(event) => {
              setServerSearch(event.currentTarget.value);
              setChatServers([]);
              setChatServersTruncated(false);
              setSelectedServerUuid(null);
              setServerResourcesError(null);
            }}
            maxLength={128}
          />
          <Select
            label={tExt('chat.statusServerSelect', {})}
            placeholder={tExt('chat.statusServerSelectPlaceholder', {})}
            data={chatServers.map((server) => ({
              value: server.uuid,
              label: `${server.name} (${server.uuidShort})`,
            }))}
            value={selectedServerUuid}
            onChange={setSelectedServerUuid}
            clearable
            disabled={chatServersLoading && chatServers.length === 0}
            nothingFoundMessage={tExt('chat.statusNoServersFound', {})}
          />
          {chatServersLoading && (
            <Group gap='xs'>
              <Loader size='xs' />
              <Text size='xs' c='dimmed'>
                {tExt('chat.statusLoadingServers', {})}
              </Text>
            </Group>
          )}
          {chatServersTruncated && (
            <Text size='xs' c='dimmed'>
              {tExt('chat.statusServerListLimited', {})}
            </Text>
          )}
          {chatServersError && (
            <Text size='sm' c='red'>
              {chatServersError}
            </Text>
          )}
          {serverResourcesLoading && (
            <Group gap='xs'>
              <Loader size='xs' />
              <Text size='xs' c='dimmed'>
                {tExt('chat.statusLoadingDetails', {})}
              </Text>
            </Group>
          )}
          {serverResourcesError && (
            <Text size='sm' c='red'>
              {serverResourcesError.kind === 'unavailable'
                ? tExt('chat.statusSelectedServerUnavailable', {})
                : serverResourcesError.message}
            </Text>
          )}
        </Stack>
      </Modal>
    </aside>
  );
}

function MessageBubble({
  message,
  own,
  senderLabel,
  onServerActionDecision,
  serverActionLoading,
  serverActionDisabled,
}: {
  message: ChatMessage;
  own: boolean;
  senderLabel: string;
  onServerActionDecision: (confirm: boolean) => void;
  serverActionLoading: boolean;
  serverActionDisabled: boolean;
}) {
  const { t: tExt } = useExtTranslations();
  const pendingAction = message.pendingAction;
  const actionLabel = pendingAction
    ? {
        start: tExt('chat.serverPowerStart', {}),
        stop: tExt('chat.serverPowerStop', {}),
        restart: tExt('chat.serverPowerRestart', {}),
      }[pendingAction.actionType]
    : '';
  const actionStatusText = pendingAction
    ? {
        pending: tExt('chat.serverActionConfirmationHint', {
          time: pendingAction.expiresAt.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          }),
        }),
        executing: tExt('chat.serverActionExecuting', {}),
        confirmed: tExt('chat.serverActionConfirmed', {}),
        cancelled: tExt('chat.serverActionCancelled', {}),
        failed: tExt('chat.serverActionFailed', {}),
        expired: tExt('chat.serverActionExpired', {}),
      }[pendingAction.status]
    : '';

  return (
    <div className={`calagopus-chat-message${own ? ' is-own' : ''}${message.isAi ? ' is-ai' : ''}`}>
      {!own && (
        <Text className='calagopus-chat-message-author' size='xs' c='dimmed'>
          {senderLabel}
        </Text>
      )}
      {message.content.trim().length > 0 && (
        <Paper withBorder radius='md' p='xs' className='calagopus-chat-message-paper'>
          {message.isAi ? (
            <div className='calagopus-chat-message-markdown'>
              <Markdown>{message.content}</Markdown>
            </div>
          ) : (
            <Text size='sm' className='calagopus-chat-message-text' style={{ whiteSpace: 'pre-wrap' }}>
              {message.content}
            </Text>
          )}
        </Paper>
      )}
      <Text className='calagopus-chat-message-time' size='xs' c='dimmed'>
        {formatTime(message.createdAt)}
      </Text>
      {pendingAction && (
        <Paper withBorder radius='sm' p='sm' className='calagopus-chat-pending-action'>
          <Text size='xs' fw={600}>
            {tExt('chat.serverActionPrompt', {
              action: actionLabel,
              server: pendingAction.serverName,
            })}
          </Text>
          {pendingAction.status === 'pending' && pendingAction.canConfirm ? (
            <>
              <Text size='xs' c='dimmed' mt={4}>
                {actionStatusText}
              </Text>
              <Group gap='xs' mt='xs' wrap='wrap'>
                <Button
                  size='xs'
                  color={pendingAction.actionType === 'start' ? 'green' : 'red'}
                  loading={serverActionLoading}
                  disabled={serverActionDisabled}
                  onClick={() => onServerActionDecision(true)}
                >
                  {tExt('chat.confirmServerAction', { action: actionLabel })}
                </Button>
                <Button
                  size='xs'
                  variant='default'
                  disabled={serverActionDisabled}
                  onClick={() => onServerActionDecision(false)}
                >
                  {tExt('chat.cancelServerAction', {})}
                </Button>
              </Group>
            </>
          ) : pendingAction.status === 'pending' ? (
            <Text size='xs' c='dimmed' mt={4}>
              {tExt('chat.serverActionOnlyRequesterCanConfirm', {})}
            </Text>
          ) : (
            <Text size='xs' c='dimmed' mt={4}>
              {actionStatusText}
            </Text>
          )}
        </Paper>
      )}
    </div>
  );
}

function UserOption({
  user,
  selected,
  groupMode,
  disabled,
  onSelect,
}: {
  user: ChatUser;
  selected: boolean;
  groupMode: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button type='button' className='calagopus-chat-user-row' onClick={onSelect} disabled={disabled}>
      <span className='calagopus-chat-user-avatar'>{user.username.slice(0, 1).toUpperCase()}</span>
      <span className='calagopus-chat-user-name'>{user.username}</span>
      {groupMode && <Checkbox checked={selected} readOnly tabIndex={-1} aria-label={`Select ${user.username}`} />}
    </button>
  );
}
